# START HERE — Windows + iPhone

If a step shows an error, screenshot it or copy the text and send it to Claude. Don't try to fix it yourself.

---

## Part 1 — Tonight (free, ~1 hour)

### 1. Start Apple Developer enrollment first
Do this before anything else, because Apple can take 1–2 days to approve.

1. Go to **developer.apple.com/programs/enroll**.
2. Enroll as an **Individual** using your Apple ID. It costs $99/year.
3. Don't pick Organization. That needs a D-U-N-S business number, and you can switch later.

### 2. Make your own Supabase project
Create a new project that **you** own, even if an old one exists. The database is the business, so it should be in your name.

1. Go to **supabase.com** → sign up → **New project**.
2. Name it `pickup-pulse`.
3. Pick the region closest to Oregon (West US).
4. Save the database password in your notes.
5. When the project is ready, click **SQL Editor** in the left sidebar → **New query**.
6. Open `supabase/migrations/01_schema_v2.sql` in Notepad. Select all (Ctrl+A), copy, paste it into Supabase, and click **Run**.
   - It should say **Success. No rows returned**.
   - Skip `00_reset_dev_only.sql`. It's only for old projects.
7. Go to **Authentication → Emails → Magic Link** template. Add this line anywhere in the message body, then Save:
   ```
   Your Pickup Pulse code: {{ .Token }}
   ```
8. Go to **Project Settings → API Keys**. Copy two things into your notes:
   - the **Project URL** (`https://xxxx.supabase.co`)
   - the **publishable key** (`sb_publishable_...`). If your project shows an `anon` key instead, use that.

### 3. Set up your computer

1. Install **Node.js LTS** from **nodejs.org**. Use the big green button and accept all the defaults.
2. Install **VS Code** from **code.visualstudio.com**. It's free, and it's where you'll open and edit the project.
3. Unzip `pickup-pulse-v2.zip` to **`C:\dev\`**, so you end up with `C:\dev\pickup-pulse`.
   - Avoid Documents or Desktop if OneDrive syncs them. OneDrive chokes on the thousands of small files the app downloads.
4. Open VS Code → **File → Open Folder** → pick `C:\dev\pickup-pulse\app`.
5. Put your Supabase keys into the project:
   - In the file list on the left, right-click **`.env.example`** → **Copy**, then right-click empty space → **Paste**.
   - Rename the copy to **`.env`**.
   - Open `.env` and paste your Project URL and key after the `=` signs. Save with Ctrl+S.

### 4. See it in your browser

1. In VS Code, open a terminal: **Terminal → New Terminal** (or press Ctrl+`).
2. Run these two commands, one at a time:
   ```
   npm install
   npx expo start --web
   ```
   - The first command takes a few minutes. Yellow warnings are normal.
3. A browser tab should open with the Pickup Pulse sign-in screen.
4. Sign in with **the same email you used for Supabase**. Supabase's built-in email only sends to project team members until you set up a real email service, which we'll do before the beta. It's also limited to a few emails per hour, so if the code doesn't come, wait a bit.
5. Post a game, then look at the feed. That's the real database working.

**If you see "running scripts is disabled on this system":** run this once, type `Y`, then try again.
```
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

To stop the app, click in the terminal and press **Ctrl+C**.

---

## Part 2 — After Apple approves you

This is how the app gets onto your iPhone. The iPhone version is built in Expo's cloud, so no Mac is needed. Tell Claude when you reach this part and it will walk through it live, because Apple's screens change often.

1. Make a free account at **expo.dev**.
2. Build the app for your iPhone using your Apple account. It installs through Apple's **TestFlight** app.
3. Run `npx expo start --tunnel` on your PC and open the app on your phone.
   - Use `--tunnel` because campus and apartment Wi-Fi often blocks your phone from seeing your PC.

Push notifications, the scheduled jobs (games automatically going live and ending), and the court GPS fixes all come after that.
