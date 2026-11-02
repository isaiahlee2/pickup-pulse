-- ============================================================
-- PICKUP PULSE — v2.2: direct messages between crew (run AFTER 03). Safe to re-run.
--
--  • Friends only: you can message someone only while you're in each other's crew
--  • Block = their messages disappear for you and they can't send more
--  • Removing a friend keeps the history but closes the chat
--  • Messages are only ever readable by the two people in the chat
--  • Written only through send_message (rate-limited) — never inserted directly
-- ============================================================

CREATE TABLE IF NOT EXISTS public.messages (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_id     UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    recipient_id  UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    body          TEXT NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 1000),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    read_at       TIMESTAMPTZ,
    CONSTRAINT no_self_message CHECK (sender_id <> recipient_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_pair
  ON public.messages (LEAST(sender_id, recipient_id), GREATEST(sender_id, recipient_id), created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_unread ON public.messages (recipient_id, sender_id) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_messages_sender_recent ON public.messages (sender_id, created_at DESC);

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.messages FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.messages TO authenticated;          -- read your own chats (also what live updates use)
GRANT ALL ON public.messages TO service_role;
DROP POLICY IF EXISTS msg_read ON public.messages;
CREATE POLICY msg_read ON public.messages FOR SELECT TO authenticated
  USING (auth.uid() IN (sender_id, recipient_id));

-- Live updates for open chats (only the two people in a chat receive its messages)
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------- Helpers ----------
CREATE OR REPLACE FUNCTION public._pair_status(a uuid, b uuid) RETURNS public.friendship_status
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT f.status FROM public.friendships f
   WHERE LEAST(f.requester_id, f.addressee_id) = LEAST(a, b)
     AND GREATEST(f.requester_id, f.addressee_id) = GREATEST(a, b)
   LIMIT 1;
$$;

-- ---------- Send ----------
CREATE OR REPLACE FUNCTION public.send_message(p_to uuid, p_body text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE uid UUID := auth.uid(); clean TEXT := btrim(COALESCE(p_body, '')); recent INTEGER; m public.messages;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Not signed in.' USING ERRCODE = '28000'; END IF;
  IF char_length(clean) = 0 THEN RAISE EXCEPTION 'Message is empty.' USING ERRCODE = 'P0001'; END IF;
  IF char_length(clean) > 1000 THEN RAISE EXCEPTION 'Message is too long (1,000 characters max).' USING ERRCODE = 'P0001'; END IF;
  IF public._pair_status(uid, p_to) IS DISTINCT FROM 'accepted' THEN
    RAISE EXCEPTION 'You can only message people in your crew.' USING ERRCODE = 'P0001';
  END IF;
  -- Serialize per sender so a burst can't slip past the limit
  PERFORM pg_advisory_xact_lock(hashtext('msg:' || uid::text));
  SELECT count(*) INTO recent FROM public.messages WHERE sender_id = uid AND created_at > now() - interval '1 minute';
  IF recent >= 20 THEN RAISE EXCEPTION 'Slow down a sec — too many messages at once.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO public.messages (sender_id, recipient_id, body) VALUES (uid, p_to, clean) RETURNING * INTO m;
  RETURN jsonb_build_object('id', m.id, 'created_at', m.created_at);
END $$;

-- ---------- One chat (newest first; pass p_before to page back) ----------
CREATE OR REPLACE FUNCTION public.get_messages(p_friend uuid, p_before timestamptz DEFAULT NULL, p_limit int DEFAULT 50)
RETURNS TABLE (id uuid, sender_id uuid, body text, created_at timestamptz, read_at timestamptz, from_me boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT m.id, m.sender_id, m.body, m.created_at, m.read_at, m.sender_id = auth.uid()
    FROM public.messages m
   WHERE ((m.sender_id = auth.uid() AND m.recipient_id = p_friend)
       OR (m.sender_id = p_friend AND m.recipient_id = auth.uid()))
     AND public._pair_status(auth.uid(), p_friend) IS DISTINCT FROM 'blocked'
     AND (p_before IS NULL OR m.created_at < p_before)
   ORDER BY m.created_at DESC
   LIMIT LEAST(GREATEST(p_limit, 1), 100);
$$;

-- ---------- Crew list: last message + unread per friend ----------
CREATE OR REPLACE FUNCTION public.get_conversations()
RETURNS TABLE (friend_id uuid, last_body text, last_at timestamptz, last_from_me boolean, unread int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH mine AS (
    SELECT m.*, CASE WHEN m.sender_id = auth.uid() THEN m.recipient_id ELSE m.sender_id END AS other
      FROM public.messages m
     WHERE auth.uid() IN (m.sender_id, m.recipient_id))
  SELECT DISTINCT ON (x.other) x.other, x.body, x.created_at, x.sender_id = auth.uid(),
         (SELECT count(*)::int FROM mine u WHERE u.other = x.other AND u.recipient_id = auth.uid() AND u.read_at IS NULL)
    FROM mine x
   WHERE public._pair_status(auth.uid(), x.other) IS DISTINCT FROM 'blocked'
   ORDER BY x.other, x.created_at DESC;
$$;

-- ---------- Unread total (Crew tab badge) ----------
CREATE OR REPLACE FUNCTION public.unread_message_count() RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT count(*)::int FROM public.messages m
   WHERE m.recipient_id = auth.uid() AND m.read_at IS NULL
     AND public._pair_status(auth.uid(), m.sender_id) IS DISTINCT FROM 'blocked';
$$;

-- ---------- Mark a chat read ----------
CREATE OR REPLACE FUNCTION public.mark_messages_read(p_friend uuid) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n INTEGER;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not signed in.' USING ERRCODE = '28000'; END IF;
  UPDATE public.messages SET read_at = now()
   WHERE recipient_id = auth.uid() AND sender_id = p_friend AND read_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- ---------- Permissions (Supabase grants new functions to everyone by default — undo that) ----------
REVOKE ALL ON FUNCTION
  public._pair_status(uuid, uuid), public.send_message(uuid, text),
  public.get_messages(uuid, timestamptz, int), public.get_conversations(),
  public.unread_message_count(), public.mark_messages_read(uuid)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.send_message(uuid, text), public.get_messages(uuid, timestamptz, int), public.get_conversations(),
  public.unread_message_count(), public.mark_messages_read(uuid)
TO authenticated;
GRANT EXECUTE ON FUNCTION
  public._pair_status(uuid, uuid), public.send_message(uuid, text),
  public.get_messages(uuid, timestamptz, int), public.get_conversations(),
  public.unread_message_count(), public.mark_messages_read(uuid)
TO service_role;
