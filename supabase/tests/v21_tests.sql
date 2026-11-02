-- ============================================================
-- PICKUP PULSE — v2.1 tests (18+ gate, ETA, shared game links, profiles, inbox)
-- ============================================================
\set QUIET on
\set ON_ERROR_STOP off
SET client_min_messages = notice;

CREATE SCHEMA t;
GRANT USAGE ON SCHEMA t TO authenticated, anon;
CREATE FUNCTION t.ok(cond boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN RAISE NOTICE '%', CASE WHEN cond THEN 'PASS  ' ELSE 'FAIL  ' END || label; END $$;
CREATE FUNCTION t.fails(sql text, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN EXECUTE sql; RAISE NOTICE 'FAIL  % (was allowed)', label;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'PASS  % → blocked: %', label, left(SQLERRM, 70); END $$;
CREATE FUNCTION t.as_user(u uuid) RETURNS void LANGUAGE sql AS
$$ SELECT set_config('request.jwt.claim.sub', u::text, false) $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, anon;

\echo
\echo '== 1. 18+ gate =='
SELECT t.fails($$INSERT INTO auth.users (id, email) VALUES ('bbbbbbbb-0000-0000-0000-000000000099', 'kid@x.com')$$, 'sign up without confirming 18+');
SELECT t.fails($$INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ('bbbbbbbb-0000-0000-0000-000000000098', 'kid2@x.com', '{"adult_confirmed": false}')$$, 'sign up with adult_confirmed = false');
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000001', 'host@osu.edu', '{"adult_confirmed": true, "full_name": "Host"}'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'jay@osu.edu',  '{"adult_confirmed": true, "full_name": "Jay"}'),
  ('bbbbbbbb-0000-0000-0000-000000000003', 'sam@osu.edu',  '{"adult_confirmed": true, "full_name": "Sam"}'),
  ('bbbbbbbb-0000-0000-0000-000000000004', 'cat@osu.edu',  '{"adult_confirmed": true, "full_name": "Cat"}');
\set H '''bbbbbbbb-0000-0000-0000-000000000001'''
\set J '''bbbbbbbb-0000-0000-0000-000000000002'''
\set S '''bbbbbbbb-0000-0000-0000-000000000003'''
\set K '''bbbbbbbb-0000-0000-0000-000000000004'''
SELECT t.ok((SELECT count(*) FROM public.users WHERE adult_confirmed) = 4, 'confirmed adults get accounts, flagged 18+');
SELECT t.ok((SELECT display_name FROM public.users WHERE id = :H) = 'Host', 'name from sign-up carried over');
SET ROLE authenticated; SELECT t.as_user(:J);
SELECT t.fails($$UPDATE public.users SET adult_confirmed = false WHERE id = auth.uid()$$, 'player edits their own 18+ flag');

\echo
\echo '== 2. New functions are locked to signed-in players =='
RESET ROLE; SET ROLE anon;
SELECT t.fails($$SELECT * FROM public.get_game(gen_random_uuid())$$, 'logged-out visitor reads a game');
SELECT t.fails($$SELECT * FROM public.get_inbox()$$, 'logged-out visitor reads an inbox');
SELECT t.fails($$SELECT * FROM public.get_profile(gen_random_uuid())$$, 'logged-out visitor reads a profile');
RESET ROLE; SET ROLE authenticated; SELECT t.as_user(:J);
SELECT t.fails($$SELECT public.on_verified_checkin()$$, 'player calls the internal arrival trigger');

\echo
\echo '== 3. ETA on "I''m in" =='
SELECT id AS hl FROM public.locations WHERE name = 'Highland Park Courts' \gset
SELECT t.as_user(:H);
INSERT INTO public.games (creator_id, location_id, sport, location_name, location_lat, location_lng, note, spots_needed, game_start_time)
VALUES (:H, :'hl', 'Basketball', 'x', 0, 0, 'run it', 3, now()) RETURNING id AS live \gset
INSERT INTO public.games (creator_id, location_id, sport, location_name, location_lat, location_lng, note, spots_needed, game_start_time)
VALUES (:H, :'hl', 'Pickleball', 'x', 0, 0, 'tomorrow doubles', 2, now() + interval '1 day') RETURNING id AS later \gset
SELECT t.as_user(:J);
SELECT t.ok((public.rsvp_join(:'live', 10))->>'status' = 'confirmed', 'Jay joins with "~10 min"');
SELECT t.ok((SELECT eta_at BETWEEN now() + interval '9 minutes' AND now() + interval '11 minutes' FROM public.rsvps WHERE game_id = :'live' AND user_id = :J),
            'ETA stored as an arrival time');
SELECT t.ok((public.rsvp_join(:'live', 2))->>'already' = 'true', 'Jay updates his ETA to ~2 min');
SELECT t.ok((SELECT eta_at < now() + interval '3 minutes' FROM public.rsvps WHERE game_id = :'live' AND user_id = :J), 'new ETA saved');
SELECT t.ok((public.rsvp_join(p_game_id => :'later'))->>'status' = 'confirmed', 'old app call (no ETA argument) still works');
SELECT t.ok((SELECT eta_at IS NULL FROM public.rsvps WHERE game_id = :'later' AND user_id = :J), 'no ETA for a game that hasn''t started');
SELECT t.fails(format('SELECT public.rsvp_join(%L, 500)', :'live'), 'ETA of 500 minutes');
SELECT t.as_user(:S);
SELECT public.rsvp_join(:'live', 0) \gset
RESET ROLE;
SELECT t.ok(EXISTS (SELECT 1 FROM public.notifications WHERE recipient_id = :H AND title LIKE 'Jay is in%~10 min'), 'host notified with Jay''s ETA');
SELECT t.ok(EXISTS (SELECT 1 FROM public.notifications WHERE recipient_id = :H AND title LIKE 'Sam is in%already there'), 'host notified Sam is already there');

\echo
\echo '== 4. Who''s coming =='
SET ROLE authenticated; SELECT t.as_user(:K);
SELECT t.ok((SELECT role FROM public.get_game_players(:'live') LIMIT 1) = 'host', 'host listed first');
SELECT t.ok((SELECT count(*) FROM public.get_game_players(:'live')) = 3, 'host + 2 players');
SELECT t.ok((SELECT NOT arrived AND eta_at IS NOT NULL FROM public.get_game_players(:'live') WHERE display_name = 'Jay'), 'Jay: on the way, not arrived');
SELECT t.as_user(:J);
SELECT public.check_in(44.5706, -123.2681, NULL, :'live') \gset
SELECT t.as_user(:K);
SELECT t.ok((SELECT arrived FROM public.get_game_players(:'live') WHERE display_name = 'Jay'), 'verified check-in flips Jay to "here"');
SELECT t.ok(NOT EXISTS (SELECT 1 FROM public.get_game_players(:'live') WHERE role = 'cancelled'), 'dropped players never listed');

\echo
\echo '== 5. Shared game links =='
SELECT t.ok((SELECT count(*) FROM public.get_game(:'live')) = 1, 'game opens by id without a location');
SELECT t.ok((SELECT distance_km IS NULL FROM public.get_game(:'live')), 'no location → no distance (no fake 0)');
SELECT t.ok((SELECT distance_km > 50 FROM public.get_game(:'live', 45.5152, -122.6784)), 'opens from Portland too (feed would hide it)');
SELECT t.as_user(:H); SELECT public.end_game(:'later') \gset
SELECT t.as_user(:K);
SELECT t.ok((SELECT status FROM public.get_game(:'later')) = 'cancelled', 'cancelled game still opens, showing it''s off');
SELECT t.ok((SELECT my_rsvp FROM public.get_game(:'live')) IS NULL, 'my_rsvp empty for Cat');
SELECT t.as_user(:J);
SELECT t.ok((SELECT my_rsvp FROM public.get_game(:'live')) = 'confirmed', 'my_rsvp shows Jay is in');
SELECT t.as_user(:K); SELECT public.remove_or_block_friend(:H, true) \gset
SELECT t.ok((SELECT count(*) FROM public.get_game(:'live')) = 0, 'Cat blocked the host → host''s game won''t open for her');

\echo
\echo '== 6. Profile card =='
SELECT t.as_user(:J);
SELECT t.ok((SELECT relation FROM public.get_profile(:J)) = 'me', 'own card says me');
SELECT t.ok((SELECT relation FROM public.get_profile(:S)) = 'none', 'stranger: none');
SELECT public.send_friend_request('player_' || substr(md5(:S), 1, 10)) \gset
SELECT t.ok((SELECT relation FROM public.get_profile(:S)) = 'requested', 'after request: requested');
SELECT t.as_user(:S);
SELECT t.ok((SELECT relation FROM public.get_profile(:J)) = 'incoming', 'other side sees incoming');
SELECT t.as_user(:H);
SELECT t.ok((SELECT relation FROM public.get_profile(:K)) = 'none', 'Cat blocked Host → Host just sees "none"');
SELECT t.ok((SELECT games_posted = 2 AND verified_checkins = 0 FROM public.get_profile(:H)), 'stats: 2 posted, 0 check-ins');
SELECT t.as_user(:K);
SELECT t.ok((SELECT relation FROM public.get_profile(:H)) = 'blocked', 'Cat sees she blocked Host');

\echo
\echo '== 7. Inbox (where invites land) =='
RESET ROLE;
INSERT INTO public.friendships (requester_id, addressee_id, status) VALUES (:H, :S, 'accepted');
SET ROLE authenticated; SELECT t.as_user(:H);
SELECT t.ok(public.invite_friends(:'live', ARRAY[:S]::uuid[], 'pull up') = 1, 'Host invites Sam');
SELECT t.as_user(:S);
SELECT t.ok((SELECT sender_name = 'Host' AND game_status = 'live' AND body = 'pull up' FROM public.get_inbox() WHERE type = 'friend_invite'),
            'invite shows in Sam''s inbox with sender + game');
SELECT t.ok((SELECT count(*) FROM public.notifications WHERE NOT is_read) >= 2, 'unread count available (request + invite)');
UPDATE public.notifications SET is_read = true WHERE NOT is_read;
SELECT t.ok((SELECT count(*) FROM public.notifications WHERE NOT is_read) = 0, 'mark all read');
SELECT t.as_user(:K);
SELECT t.ok(NOT EXISTS (SELECT 1 FROM public.get_inbox() WHERE type = 'friend_invite'), 'nobody else can see Sam''s invite');
SELECT t.fails(format($$UPDATE public.notifications SET title = 'hacked' WHERE recipient_id = %L$$, :S), 'edit notification text');

\echo
\echo '== 8. "Up to 2 days out" = calendar days =='
SET ROLE authenticated; SELECT t.as_user(:S);
INSERT INTO public.games (creator_id, sport, location_name, location_lat, location_lng, note, game_start_time)
VALUES (:S, 'Soccer', 'Fields', 44.56, -123.28, 'late game in 2 days',
        (date_trunc('day', now() AT TIME ZONE 'America/Los_Angeles') + interval '2 days 23 hours') AT TIME ZONE 'America/Los_Angeles')
RETURNING id AS late2 \gset
SELECT t.ok(:'late2' IS NOT NULL, '11 PM the day after tomorrow is allowed (was rejected before)');
SELECT t.fails($$INSERT INTO public.games (creator_id, sport, location_name, location_lat, location_lng, note, game_start_time)
  VALUES ('bbbbbbbb-0000-0000-0000-000000000003', 'Soccer', 'Fields', 44.56, -123.28, '3 days out',
          (date_trunc('day', now() AT TIME ZONE 'America/Los_Angeles') + interval '3 days 1 hour') AT TIME ZONE 'America/Los_Angeles')$$,
  '3 calendar days out');
