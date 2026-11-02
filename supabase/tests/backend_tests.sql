-- ============================================================
-- PICKUP PULSE — backend test suite
-- Runs against a local Postgres with Supabase stubs (see run_tests.sh).
-- Every line of output is PASS or FAIL.
-- ============================================================
\set QUIET on
\set ON_ERROR_STOP off
SET client_min_messages = notice;

CREATE SCHEMA t;
GRANT USAGE ON SCHEMA t TO authenticated;
CREATE FUNCTION t.ok(cond boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN RAISE NOTICE '%', CASE WHEN cond THEN 'PASS  ' ELSE 'FAIL  ' END || label; END $$;
CREATE FUNCTION t.fails(sql text, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN EXECUTE sql; RAISE NOTICE 'FAIL  % (was allowed)', label;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'PASS  % → blocked: %', label, left(SQLERRM, 70); END $$;
CREATE FUNCTION t.as_user(u uuid) RETURNS void LANGUAGE sql AS
$$ SELECT set_config('request.jwt.claim.sub', u::text, false) $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated;

-- Players (signup trigger creates their profiles)
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'marcus@osu.edu', '{"adult_confirmed": true}'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'jaylen@osu.edu', '{"adult_confirmed": true}'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'sofia@osu.edu', '{"adult_confirmed": true}'),
  ('aaaaaaaa-0000-0000-0000-000000000004', 'andre@osu.edu', '{"adult_confirmed": true}'),
  ('aaaaaaaa-0000-0000-0000-000000000005', 'priya@osu.edu', '{"adult_confirmed": true}'),
  ('aaaaaaaa-0000-0000-0000-000000000006', 'spammer@osu.edu', '{"adult_confirmed": true}');
UPDATE public.users SET username = display_name;
\set A '''aaaaaaaa-0000-0000-0000-000000000001'''
\set B '''aaaaaaaa-0000-0000-0000-000000000002'''
\set C '''aaaaaaaa-0000-0000-0000-000000000003'''
\set D '''aaaaaaaa-0000-0000-0000-000000000004'''
\set E '''aaaaaaaa-0000-0000-0000-000000000005'''
\set F '''aaaaaaaa-0000-0000-0000-000000000006'''
SELECT id AS hl FROM public.locations WHERE name = 'Highland Park Courts' \gset
-- Sofia lives near Highland and plays basketball; Andre lives in Portland
UPDATE public.user_settings SET home_lat = 44.5720, home_lng = -123.2690, push_token = 'ExponentPushToken[sofia]' WHERE user_id = :C;
UPDATE public.users SET preferred_sports = '{Basketball}' WHERE id = :C;
UPDATE public.user_settings SET home_lat = 45.5152, home_lng = -122.6784 WHERE user_id = :D;

\echo
\echo '== 1. Schema =='
SELECT t.ok(to_regclass('public.friendships') IS NOT NULL, 'friendships table exists (v1 bug fixed)');
SELECT t.ok((SELECT count(*) FROM public.users) = 6, 'signup trigger created 6 profiles');
SELECT t.ok((SELECT count(*) FROM public.user_settings) = 6, 'signup trigger created 6 private settings rows');

\echo
\echo '== 2. The v1 cheats are blocked =='
SET ROLE authenticated;
SELECT t.as_user(:F);
SELECT t.fails($$INSERT INTO public.checkins(user_id,user_lat,user_lng,distance_m,is_verified)
                 VALUES ('aaaaaaaa-0000-0000-0000-000000000006',0,0,1,true)$$, 'forge a verified check-in directly');
SELECT t.fails($$UPDATE public.users SET trust_score = 9999 WHERE id = 'aaaaaaaa-0000-0000-0000-000000000006'$$, 'set own trust score');
SELECT t.fails($$INSERT INTO public.games(creator_id,sport,location_name,location_lat,location_lng,note,game_start_time,is_verified,checkin_count)
                 VALUES ('aaaaaaaa-0000-0000-0000-000000000006','Basketball','x',44.57,-123.27,'fake',now(),true,50)$$, 'post a pre-verified game');
SELECT t.fails($$INSERT INTO public.rsvps(user_id,game_id) SELECT 'aaaaaaaa-0000-0000-0000-000000000006', gen_random_uuid()$$, 'write an RSVP directly (skip capacity check)');
SELECT t.fails($$SELECT public.tick_game_lifecycle()$$, 'run the lifecycle job from the app');
SELECT t.fails($$SELECT * FROM public.claim_push_batch()$$, 'drain the push queue from the app');
SELECT t.ok((SELECT count(*) FROM public.user_settings) = 1, 'can only read own private settings (no one else''s home location)');
-- A legit post by F, then try to flip it verified
INSERT INTO public.games (creator_id, sport, location_name, location_lat, location_lng, note, game_start_time)
VALUES (:F, 'Basketball', 'Somewhere', 44.57, -123.27, 'shootaround', now()) RETURNING id AS fgame \gset
SELECT t.fails(format($$UPDATE public.games SET is_verified = true, checkin_count = 50 WHERE id = %L$$, :'fgame'), 'mark own game verified');
SELECT t.fails(format($$UPDATE public.games SET status = 'live' WHERE id = %L$$, :'fgame'), 'change own game status directly');

\echo
\echo '== 3. Posting rules =='
SELECT t.as_user(:A);
INSERT INTO public.games (creator_id, location_id, sport, location_name, location_lat, location_lng, note, total_players, spots_needed, game_start_time)
VALUES (:A, :'hl', 'Basketball', 'lies', 0, 0, 'Running 5s, need 2', 8, 2, now()) RETURNING id AS g1 \gset
SELECT t.ok((SELECT location_name = 'Highland Park Courts' AND abs(location_lat - 44.5705) < 1e-6 FROM public.games WHERE id = :'g1'),
            'client-sent coordinates replaced with the directory''s');
SELECT t.ok((SELECT status = 'live' FROM public.games WHERE id = :'g1'), '"Right now" game starts live');
SELECT t.fails(format($$INSERT INTO public.games (creator_id, sport, location_name, location_lat, location_lng, note, game_start_time)
                 VALUES (%L,'Soccer','x',44.5,-123.2,'too far out', now() + interval '3 days')$$, :A), 'post 3 days ahead (limit is 2)');
INSERT INTO public.games (creator_id, sport, location_name, location_lat, location_lng, note, game_start_time)
VALUES (:A,'Soccer','Riverfront',44.567,-123.261,'7v7 tmrw', now() + interval '1 day'),
       (:A,'Soccer','Riverfront',44.567,-123.261,'7v7 sat',  now() + interval '2 days' - interval '1 minute');
SELECT t.fails(format($$INSERT INTO public.games (creator_id, sport, location_name, location_lat, location_lng, note, game_start_time)
                 VALUES (%L,'Soccer','x',44.5,-123.2,'4th post', now() + interval '1 hour')$$, :A), '4th active post (limit is 3)');

\echo
\echo '== 4. Nearby-game notifications =='
RESET ROLE;
SELECT t.ok(EXISTS (SELECT 1 FROM public.notifications WHERE recipient_id = :C AND type = 'nearby_game' AND game_id = :'g1'),
            'Sofia (lives 200 m away, plays basketball) was notified');
SELECT t.ok(NOT EXISTS (SELECT 1 FROM public.notifications WHERE recipient_id = :D AND type = 'nearby_game' AND game_id = :'g1'),
            'Andre (lives in Portland) was not');
SELECT t.ok(NOT EXISTS (SELECT 1 FROM public.notifications WHERE recipient_id = :C AND type = 'nearby_game' AND data->>'distance_km' IS NULL),
            'notification carries the distance');

\echo
\echo '== 5. RSVPs (game needs 2) =='
SET ROLE authenticated;
SELECT t.as_user(:B); SELECT t.ok((public.rsvp_join(:'g1'))->>'status' = 'confirmed', 'Jaylen joins → confirmed');
SELECT t.as_user(:C); SELECT t.ok((public.rsvp_join(:'g1'))->>'spots_open' = '0',   'Sofia joins → confirmed, 0 spots open');
SELECT t.as_user(:D); SELECT t.ok((public.rsvp_join(:'g1'))->>'status' = 'waitlisted', 'Andre joins full game → waitlisted');
SELECT t.as_user(:B); SELECT t.ok((public.rsvp_join(:'g1'))->>'already' = 'true', 'Jaylen taps "I''m In" twice → no double count');
SELECT t.ok((SELECT current_rsvps FROM public.games WHERE id = :'g1') = 2, 'current_rsvps = 2 (v1 trigger would have drifted)');
SELECT t.ok((public.rsvp_cancel(:'g1'))->>'promoted' = 'true', 'Jaylen drops → waitlist promotes');
SELECT t.ok((SELECT status FROM public.rsvps WHERE game_id = :'g1' AND user_id = :D) = 'confirmed', 'Andre is now confirmed');
SELECT t.ok((SELECT spots_open FROM public.games WHERE id = :'g1') = 0, 'still 0 spots open');
SELECT t.as_user(:A); SELECT t.fails(format('SELECT public.rsvp_join(%L)', :'g1'), 'poster RSVPs to own game');
UPDATE public.games SET spots_needed = 3 WHERE id = :'g1';
SELECT t.ok((SELECT spots_open FROM public.games WHERE id = :'g1') = 1, 'poster raises "need" to 3 → 1 spot opens');
RESET ROLE;
SELECT t.ok(EXISTS (SELECT 1 FROM public.notifications WHERE recipient_id = :D AND title LIKE 'A spot opened%'), 'Andre got the "spot opened" notification');

\echo
\echo '== 6. GPS check-ins =='
SET ROLE authenticated;
SELECT t.as_user(:B); SELECT t.ok((public.check_in(44.5706, -123.2681, NULL, :'g1'))->>'verified' = 'true', 'Jaylen 15 m away → verified');
SELECT t.as_user(:C); SELECT t.ok((public.check_in(44.5740, -123.2680, NULL, :'g1'))->>'verified' = 'false', 'Sofia 390 m away → not verified');
SELECT t.as_user(:B); SELECT t.fails(format('SELECT public.check_in(44.5706,-123.2681,NULL,%L)', :'g1'), 'Jaylen checks in twice');
RESET ROLE;
-- Andre "checked in" in Portland 5 minutes ago
INSERT INTO public.checkins (user_id, user_lat, user_lng, distance_m, is_verified, created_at)
VALUES (:D, 45.5152, -122.6784, 0, true, now() - interval '5 minutes');
SET ROLE authenticated;
SELECT t.as_user(:D);
SELECT t.ok((public.check_in(44.5705, -123.2680, NULL, :'g1'))->>'verified' = 'false', 'Andre teleports from Portland (~1,500 km/h) → rejected');
SELECT t.as_user(:E); SELECT t.ok((public.check_in(44.5704, -123.2679, NULL, :'g1'))->>'verified' = 'true', 'Priya → verified');
SELECT t.ok((SELECT NOT is_verified FROM public.games WHERE id = :'g1'), '2 verified check-ins → no badge yet');
SELECT t.as_user(:A); SELECT public.check_in(44.5705, -123.2680, NULL, :'g1') \gset ck_
SELECT t.ok((SELECT is_verified AND checkin_count = 3 FROM public.games WHERE id = :'g1'), '3rd verified check-in → game earns the badge');
RESET ROLE;
SELECT t.ok(EXISTS (SELECT 1 FROM public.notifications WHERE recipient_id = :A AND type = 'game_verified'), 'poster notified of verification');
SELECT t.ok((SELECT trust_score FROM public.users WHERE id = :B) = 1 AND (SELECT trust_score FROM public.users WHERE id = :D) = 0,
            'trust score only rises for verified check-ins');
-- Rate limit: 5 check-ins in the last hour already
INSERT INTO public.checkins (user_id, user_lat, user_lng, distance_m, is_verified, created_at)
SELECT :F, 44.5705, -123.2680, 0, true, now() - (i || ' minutes')::interval FROM generate_series(10, 50, 10) i;
SET ROLE authenticated; SELECT t.as_user(:F);
SELECT t.fails(format('SELECT public.check_in(44.5705,-123.2680,%L,NULL)', :'hl'), '6th check-in within an hour');
SELECT t.ok((SELECT count(*) FROM public.checkins) = 5, 'players can only see their own check-in history (GPS privacy)');
RESET ROLE;

\echo
\echo '== 7. Friends =='
SET ROLE authenticated; SELECT t.as_user(:B);
SELECT t.ok((public.send_friend_request('sofia'))->>'status' = 'pending', 'Jaylen requests Sofia');
SELECT t.fails($$SELECT public.send_friend_request('jaylen')$$, 'friend yourself');
SELECT t.as_user(:C);
SELECT t.ok((SELECT incoming FROM public.get_crew() WHERE username = 'jaylen'), 'Sofia sees an incoming request');
SELECT t.ok((public.respond_friend_request((SELECT friendship_id FROM public.get_crew() WHERE username = 'jaylen'), true))->>'status' = 'accepted', 'Sofia accepts');
SELECT t.ok((SELECT active_game_label FROM public.get_crew() WHERE username = 'jaylen') IS NULL, 'crew status: Jaylen isn''t in an active game (dropped out earlier)');
SELECT t.as_user(:B);
SELECT t.ok(public.invite_friends(:'g1', ARRAY[:C, :D]::uuid[], 'pull up') = 1, 'invite Sofia + Andre → only Sofia (actual friend) gets it');
SELECT t.as_user(:D);
SELECT t.ok((public.remove_or_block_friend(:A, true))->>'status' = 'blocked', 'Andre blocks Marcus');

\echo
\echo '== 8. Ranked feed =='
SELECT t.as_user(:D);
SELECT t.ok(NOT EXISTS (SELECT 1 FROM public.get_feed(44.571, -123.269) WHERE creator_id = :A), 'blocked player''s games are hidden from Andre');
SELECT t.as_user(:B);
SELECT t.ok((SELECT id FROM public.get_feed(44.571, -123.269) LIMIT 1) = :'g1', 'live verified game is first in Jaylen''s feed');
SELECT t.ok((SELECT friend_involved FROM public.get_feed(44.571, -123.269) WHERE id = :'g1'), 'friend involvement detected (Sofia is in)');
SELECT t.ok((SELECT my_rsvp FROM public.get_feed(44.571, -123.269) WHERE id = :'g1') = 'cancelled', 'feed shows Jaylen''s own RSVP state');
SELECT t.ok(NOT EXISTS (SELECT 1 FROM public.get_feed(45.5152, -122.6784)), 'nothing shows up from Portland (outside 25 km)');
SELECT t.ok((SELECT bool_and(status <> 'ended') FROM public.get_feed(44.571, -123.269)), 'ended games never appear');
RESET ROLE;

\echo
\echo '== 9. Game lifecycle (time travel) =='
SET ROLE authenticated; SELECT t.as_user(:B);
INSERT INTO public.games (creator_id, sport, location_name, location_lat, location_lng, note, game_start_time)
VALUES (:B, 'Basketball', 'Sunset Park', 44.582, -123.259, 'tonight', now() + interval '1 hour') RETURNING id AS g2 \gset
INSERT INTO public.games (creator_id, sport, location_name, location_lat, location_lng, note, game_start_time)
VALUES (:B, 'Basketball', 'Sunset Park', 44.582, -123.259, 'ghost game', now() + interval '1 hour') RETURNING id AS g3 \gset
SELECT t.ok((SELECT status FROM public.games WHERE id = :'g2') = 'upcoming', 'scheduled game starts as upcoming');
RESET ROLE;
SELECT public.tick_game_lifecycle(now() + interval '61 minutes') \gset
SELECT t.ok((SELECT status FROM public.games WHERE id = :'g2') = 'live', 'tick at game time → live');
SELECT public.tick_game_lifecycle(now() + interval '60 minutes' + interval '121 minutes') \gset
SELECT t.ok((SELECT status FROM public.games WHERE id = :'g2') = 'check', 'tick after 2-hour window → "still going?"');
SELECT t.ok(EXISTS (SELECT 1 FROM public.notifications WHERE recipient_id = :B AND game_id = :'g2' AND type = 'still_going_ping'), 'poster pinged');
SET ROLE authenticated; SELECT t.as_user(:B);
SELECT t.fails(format($$SELECT public.respond_still_going(%L,'extend','because I said so')$$, :'g2'), 'extend with a made-up reason');
SELECT t.as_user(:C);
SELECT t.fails(format($$SELECT public.respond_still_going(%L,'extend','Running it back')$$, :'g2'), 'someone else extends your game');
SELECT t.as_user(:B);
SELECT t.ok((public.respond_still_going(:'g2', 'extend', 'Running it back'))->>'status' = 'live', 'poster extends with a real reason → live +60');
RESET ROLE;
SELECT public.tick_game_lifecycle(now() + interval '60 minutes' + interval '170 minutes') \gset
SELECT t.ok((SELECT status FROM public.games WHERE id = :'g2') = 'live', 'still live inside the extension');
SELECT public.tick_game_lifecycle(now() + interval '60 minutes' + interval '181 minutes') \gset
SELECT t.ok((SELECT status FROM public.games WHERE id = :'g2') = 'ended', 'extension used up → ended (max 1 extension)');
SELECT t.ok((SELECT status FROM public.games WHERE id = :'g3') = 'ended' AND (SELECT still_going_response FROM public.games WHERE id = :'g3') = 'no',
            'ghost game: no answer within 5 min → auto-ended');

\echo
\echo '== 10. Predictions (local time) =='
-- Three past Tuesdays at 6:00 PM Pacific at Highland
SET session_replication_role = replica;   -- skip posting-rule triggers for historical data
INSERT INTO public.games (creator_id, location_id, sport, location_name, location_lat, location_lng, note,
                          total_players, spots_needed, current_rsvps, checkin_count, status, game_start_time)
SELECT :A, :'hl', 'Basketball', 'Highland Park Courts', 44.5705, -123.2680, 'weekly run', 8, 2, 2, 4, 'ended',
       ((date_trunc('week', now() AT TIME ZONE 'America/Los_Angeles') - (w || ' weeks')::interval + interval '1 day 18 hours')
         AT TIME ZONE 'America/Los_Angeles')
  FROM generate_series(1, 3) w;
SET session_replication_role = origin;
SELECT public.refresh_activity_stats() \gset
SELECT t.ok(EXISTS (SELECT 1 FROM public.activity_stats WHERE location_id = :'hl' AND day_of_week = 2 AND hour_of_day = 18),
            'Tuesday 6 PM PT run lands in the Tuesday/18:00 bucket (not Wednesday 01:00 UTC)');
SELECT t.ok((SELECT confidence FROM public.activity_stats WHERE location_id = :'hl' AND day_of_week = 2 AND hour_of_day = 18) BETWEEN 60 AND 95,
            'confidence reflects 3 of 4 weeks with steady check-ins');

\echo
\echo '== 11. Push queue =='
UPDATE public.user_settings SET push_token = 'ExponentPushToken[andre]',
       dnd_start = ((now() AT TIME ZONE 'America/Los_Angeles')::time - interval '1 hour'),
       dnd_end   = ((now() AT TIME ZONE 'America/Los_Angeles')::time + interval '1 hour')
 WHERE user_id = :D;
CREATE TEMP TABLE batch1 AS SELECT * FROM public.claim_push_batch(500);
SELECT t.ok(EXISTS (SELECT 1 FROM batch1 WHERE push_token = 'ExponentPushToken[sofia]'), 'Sofia''s notifications go out');
SELECT t.ok(NOT EXISTS (SELECT 1 FROM batch1 WHERE push_token = 'ExponentPushToken[andre]'), 'Andre is in do-not-disturb → held back');
SELECT t.ok(NOT EXISTS (SELECT 1 FROM public.claim_push_batch(500)), 'second run sends nothing (no double pushes)');
SELECT t.ok(NOT EXISTS (SELECT 1 FROM public.notifications WHERE push_state = 'pending'), 'queue fully drained');
