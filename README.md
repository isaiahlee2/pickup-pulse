# Pickup Pulse 🏀📡

> **New here? Open `START_HERE.md` first.**

**Waze for pickup sports.** Real-time, crowdsourced feed of pickup games — post a run, see who's playing, check in with GPS, and the app learns when courts are usually busy. Piloting at Oregon State (Corvallis).

```
pickup-pulse/
├── app/                         Expo (SDK 57) React Native app — TypeScript, Expo Router
│   ├── src/app/(tabs)/          Feed · Map · Post · Crew · Me
│   ├── src/app/                 sign-in, check-in (modal), invite (modal), root layout
│   ├── src/components/          game card, "still going?" sheet, trends, UI kit
│   ├── src/hooks/               session, location (incl. precise GPS for check-ins), live feed
│   └── src/lib/                 supabase client, push registration, theme, timing math
└── supabase/
    ├── migrations/
    │   ├── 00_reset_dev_only.sql   wipes the old v1 schema (dev project only)
    │   ├── 01_schema_v2.sql        tables, security, all server logic
    │   └── 02_cron_jobs.sql        every-minute lifecycle + push, nightly predictions
    ├── functions/send-push/     the only Edge Function (delivers pushes via Expo)
    └── tests/                   70-check test suite + a 20-player race test
```

## What changed in v2 (read this if you set up v1)

1. **v1's schema had a bug** — the `friendships` table failed to create (Postgres doesn't allow `LEAST()` in a table constraint), so anything Crew-related had no table behind it.
2. **v1's security let players fake trust.** Tested against a real database: a signed-in user could insert a "verified" check-in from their couch, set their own trust score to 9999, and mark their own game verified with 50 check-ins. v2 revokes direct writes; check-ins, RSVPs, friend requests, and game status go through server functions only. All 3 attacks now fail (tests section 2).
3. **Most logic moved from Edge Functions into Postgres.** The 7 Edge Functions became 1. RSVPs lock the game row, so 20 simultaneous "I'm In" taps on the last spot produce exactly 1 confirmed + 19 waitlisted (`tests/race_test.sh`).
4. **Push switched to Expo's push service.** v1 used Firebase's legacy endpoint, which Google retired. Expo's service handles iOS and Android with one token and is free.
5. **Privacy:** home location and push tokens moved to a private table; raw check-in GPS is visible only to its owner.
6. **Predictions use Pacific time.** v1 bucketed by UTC, which would have filed a Tuesday 6 PM run under Wednesday 1 AM.
7. **Tunable settings** (check-in radius, window length, post limits, extend reasons…) live in the `app_settings` table — edit in the dashboard, no redeploy.
8. **Posting limit is now 3 active posts** (was 1). With 2-day advance posting, a limit of 1 meant you couldn't post Saturday's game while playing Thursday. Change `max_active_posts` back to 1 if you disagree.

## Setup — backend (≈20 min)

1. **Supabase project.** Use your existing one or make a new one.
2. **SQL Editor →** run `00_reset_dev_only.sql` (only if v1 was ever applied — it deletes app data), then run `01_schema_v2.sql`.
3. **Email code sign-in:** Authentication → Emails → *Magic Link* template → make sure the body includes `{{ .Token }}` so players get a 6-digit code. (Codes work in Expo Go with no deep-link setup.)
4. **Push function:** install the Supabase CLI, then
   ```bash
   supabase link --project-ref YOUR_PROJECT_REF
   supabase secrets set CRON_SECRET=$(openssl rand -hex 24)
   supabase functions deploy send-push --no-verify-jwt
   ```
5. **Scheduled jobs:** Database → Extensions → enable `pg_cron` and `pg_net`. Open `02_cron_jobs.sql`, fill in your project ref + the same CRON_SECRET, run it. It also lists existing cron jobs — **unschedule the old every-minute job** you set up earlier if it calls a v1 function.
6. **Fix the court coordinates.** The seeded Corvallis locations are approximate. A 150 m check-in radius is unforgiving — stand at each court, drop a pin, update `lat`/`lng` in the `locations` table.

## Setup — app

```bash
cd app
cp .env.example .env        # paste your Project URL + anon key (Settings → API)
npm install
npx expo start              # scan the QR code with Expo Go (iPhone: see START_HERE.md Part 2)
```

**Browser preview:** `npx expo start --web` runs the app in a browser (the Map tab shows a court list instead of a map; no push).

**What works in Expo Go:** everything except remote push notifications (Expo removed push from Expo Go in SDK 53). The app detects Expo Go and skips push registration; notifications still land in the database.

**For push:** make a development build — `npx eas-cli build --profile development --platform android` (free; iOS dev builds need an Apple Developer account, $99/yr). Android dev builds also need a Google Maps API key for the Map tab (`android.config.googleMaps.apiKey` in app.json) — Expo Go supplies its own key, so you won't notice until then.

## Running the backend tests locally

Needs Postgres 16. `tests/supabase_stub.sql` fakes the parts of Supabase the schema touches (auth schema, roles, realtime publication).
```bash
cd supabase/tests && ./run_tests.sh      # 70 checks, prints PASS/FAIL
./race_test.sh                            # 20 players race for 1 spot
```
Run these after any change to `01_schema_v2.sql`.

## Verified vs. not yet verified

| Verified here | Not verifiable here — needs a real phone / project |
|---|---|
| Schema applies cleanly, including over a v1 database | Supabase-hosted behavior (Auth emails, Realtime delivery, pg_cron timing) |
| All 70 backend checks + concurrency race | GPS accuracy at actual Corvallis courts |
| Edge Function type-checks under Deno | Push delivery end-to-end |
| App type-checks in strict mode | How the UI feels on a phone; layout on small screens |
| Metro builds both Android and iOS bundles | App Store / Play review |

## Still to build before a public beta

- **Account deletion screen** — Apple requires in-app deletion for any app with sign-up. Also a privacy policy URL.
- **Report button** on game cards (the `reports` table + permissions exist; no UI yet) and a way for you to review reports.
- **Notification inbox** screen, and tapping a push should open that specific game (currently lands on the feed).
- **Onboarding** (pick sports, set home area, allow location/notifications) — today those live on the Me tab.
- Google / Apple sign-in, profile photos, "suggest a court" flow, offline cache of the last feed.

## Known limit: GPS spoofing

Server-side distance math stops people from **editing requests** to claim "verified." It does not stop a fake-GPS app from feeding the phone false coordinates — nothing that trusts phone GPS can. Current defenses: impossible-travel detection, rate limits, needing 3 *different* people to verify a game, and trust scores that accrue slowly. If spoofing shows up in the beta, the next step is device attestation (Play Integrity / App Attest).
