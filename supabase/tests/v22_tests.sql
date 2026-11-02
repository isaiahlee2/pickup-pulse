-- ============================================================
-- PICKUP PULSE — v2.2 tests (crew DMs)
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

INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('cccccccc-0000-0000-0000-000000000001', 'jay@osu.edu', '{"adult_confirmed": true, "full_name": "Jay"}'),
  ('cccccccc-0000-0000-0000-000000000002', 'sam@osu.edu', '{"adult_confirmed": true, "full_name": "Sam"}'),
  ('cccccccc-0000-0000-0000-000000000003', 'kim@osu.edu', '{"adult_confirmed": true, "full_name": "Kim"}'),
  ('cccccccc-0000-0000-0000-000000000004', 'lee@osu.edu', '{"adult_confirmed": true, "full_name": "Lee"}');
\set J '''cccccccc-0000-0000-0000-000000000001'''
\set S '''cccccccc-0000-0000-0000-000000000002'''
\set K '''cccccccc-0000-0000-0000-000000000003'''
\set L '''cccccccc-0000-0000-0000-000000000004'''
INSERT INTO public.friendships (requester_id, addressee_id, status) VALUES
  (:J, :S, 'accepted'), (:J, :L, 'accepted'), (:J, :K, 'pending');

\echo
\echo '== 1. Sending =='
SET ROLE authenticated; SELECT t.as_user(:J);
SELECT t.ok((public.send_message(:S, '  running at dixon at 7?  '))->>'id' IS NOT NULL, 'Jay messages Sam (crew)');
SELECT t.ok((SELECT body FROM public.messages ORDER BY created_at DESC LIMIT 1) = 'running at dixon at 7?', 'extra spaces trimmed');
SELECT t.fails(format('SELECT public.send_message(%L, %L)', :K, 'hey'), 'message someone with only a pending request');
SELECT t.fails(format('SELECT public.send_message(%L, %L)', :J, 'me'), 'message yourself');
SELECT t.fails(format('SELECT public.send_message(%L, %L)', :S, '   '), 'blank message');
SELECT t.fails(format('SELECT public.send_message(%L, %L)', :S, repeat('x', 1001)), '1,001-character message');
SELECT t.fails(format($$INSERT INTO public.messages (sender_id, recipient_id, body) VALUES (%L, %L, 'sneaky')$$, :J, :S), 'insert a message directly');
SELECT t.fails(format($$INSERT INTO public.messages (sender_id, recipient_id, body) VALUES (%L, %L, 'forged')$$, :S, :J), 'forge a message from someone else');

\echo
\echo '== 2. Reading =='
SELECT t.as_user(:S);
SELECT t.ok(public.unread_message_count() = 1, 'Sam has 1 unread');
SELECT t.ok((SELECT unread = 1 AND NOT last_from_me AND last_body = 'running at dixon at 7?' FROM public.get_conversations() WHERE friend_id = :J),
            'Sam''s crew list shows Jay''s last message + unread');
SELECT t.ok((SELECT count(*) FROM public.get_messages(:J)) = 1, 'Sam opens the chat');
SELECT public.send_message(:J, 'bet, see you there') \gset
SELECT t.ok(public.mark_messages_read(:J) = 1, 'opening the chat marks it read');
SELECT t.ok(public.unread_message_count() = 0, 'Sam back to 0 unread');
SELECT t.fails($$UPDATE public.messages SET body = 'edited'$$, 'edit a message');
SELECT t.fails($$DELETE FROM public.messages$$, 'delete messages');
SELECT t.as_user(:K);
SELECT t.ok((SELECT count(*) FROM public.messages) = 0, 'outsider sees no messages in the table');
SELECT t.ok((SELECT count(*) FROM public.get_messages(:J)) = 0, 'outsider can''t open Jay''s chats');
SELECT t.ok(public.mark_messages_read(:J) = 0, 'outsider can''t mark Sam''s messages read');
SELECT t.as_user(:J);
SELECT t.ok((SELECT count(*) FROM public.messages) = 2, 'Jay sees exactly his 2-message chat');
SELECT t.ok((SELECT from_me FROM public.get_messages(:S) ORDER BY created_at LIMIT 1), 'from_me flag correct');
SELECT t.ok((SELECT count(*) FROM public.get_messages(:S, now() - interval '1 hour')) = 0, 'paging back: nothing older');

\echo
\echo '== 3. Logged out =='
RESET ROLE; SET ROLE anon;
SELECT t.fails(format('SELECT public.send_message(%L, %L)', :S, 'hi'), 'logged-out send');
SELECT t.fails('SELECT * FROM public.messages', 'logged-out read table');
SELECT t.fails('SELECT public.unread_message_count()', 'logged-out unread count');

\echo
\echo '== 4. Spam limit =='
RESET ROLE; SET ROLE authenticated; SELECT t.as_user(:J);
SELECT public.send_message(:L, 'msg ' || i) FROM generate_series(1, 19) i \gset
SELECT t.fails(format('SELECT public.send_message(%L, %L)', :L, 'one too many'), '21st message in a minute');

\echo
\echo '== 5. Remove + block =='
SELECT t.as_user(:L); SELECT public.remove_or_block_friend(:J, false) \gset
SELECT t.ok((SELECT count(*) FROM public.get_messages(:J)) = 19, 'after unfriending, history still readable');
SELECT t.fails(format('SELECT public.send_message(%L, %L)', :J, 'still there?'), 'send after unfriending');
SELECT t.as_user(:S); SELECT public.remove_or_block_friend(:J, true) \gset
SELECT t.as_user(:J);
SELECT t.fails(format('SELECT public.send_message(%L, %L)', :S, 'why'), 'blocked person sends');
SELECT t.as_user(:S);
SELECT t.ok((SELECT count(*) FROM public.get_messages(:J)) = 0, 'blocker no longer sees the chat');
SELECT t.ok(NOT EXISTS (SELECT 1 FROM public.get_conversations() WHERE friend_id = :J), 'blocked chat gone from crew list');
SELECT t.ok(public.unread_message_count() = 0, 'blocked person''s messages don''t count as unread');
