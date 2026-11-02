-- ============================================================
-- PICKUP PULSE — v2.1 (run AFTER 01_schema_v2.sql)
-- Paste into the Supabase SQL Editor. Safe to re-run.
--
--  1. 18+ only: every new account must confirm it at sign-up
--  2. "I'm in" carries an ETA; a verified check-in marks you as arrived
--  3. get_game        — one game by id (for shared links)
--  4. get_game_players — who's in, who's on the way, who's here
--  5. get_profile     — reputation card (stats only, no activity history)
--  6. get_inbox       — the notifications screen (where invites land)
--  7. "Up to 2 days out" means calendar days, not exactly 48 hours
-- ============================================================

-- ---------- 1. Adults only ----------
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS adult_confirmed BOOLEAN NOT NULL DEFAULT false;
-- Accounts made before the gate existed (owner + test accounts)
UPDATE public.users SET adult_confirmed = true WHERE NOT adult_confirmed;

CREATE OR REPLACE FUNCTION public.handle_new_auth_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE base TEXT := 'player_' || substr(md5(NEW.id::text), 1, 10);
BEGIN
  -- The sign-up screen sends {"adult_confirmed": true} after the 18+ checkbox.
  -- Any sign-up path that skips it (an old app version, a raw API call) is refused.
  -- Adding a user from the Supabase dashboard? Put {"adult_confirmed": true} in its metadata.
  IF COALESCE(NEW.raw_user_meta_data->>'adult_confirmed', '') <> 'true' THEN
    RAISE EXCEPTION 'Pickup Pulse is for players 18 and older.' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.users (id, username, display_name, adult_confirmed)
  VALUES (NEW.id, base, COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1), 'Player'), true)
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.user_settings (user_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;

-- ---------- 2. ETA + arrival ----------
ALTER TABLE public.rsvps ADD COLUMN IF NOT EXISTS eta_at TIMESTAMPTZ;
ALTER TABLE public.rsvps ADD COLUMN IF NOT EXISTS arrived_at TIMESTAMPTZ;

DROP FUNCTION IF EXISTS public.rsvp_join(uuid);
CREATE OR REPLACE FUNCTION public.rsvp_join(p_game_id uuid, p_eta_minutes int DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  uid UUID := auth.uid(); g public.games; existing public.rsvps; new_status public.rsvp_status;
  me TEXT; open_after INTEGER; eta TIMESTAMPTZ; eta_txt TEXT := '';
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Not signed in.' USING ERRCODE = '28000'; END IF;
  IF p_eta_minutes IS NOT NULL AND p_eta_minutes NOT BETWEEN 0 AND 180 THEN
    RAISE EXCEPTION 'ETA must be between 0 and 180 minutes.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO g FROM public.games WHERE id = p_game_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Game not found.' USING ERRCODE = 'P0001'; END IF;
  IF g.status NOT IN ('upcoming','live','check') THEN RAISE EXCEPTION 'That game has ended.' USING ERRCODE = 'P0001'; END IF;
  IF g.creator_id = uid THEN RAISE EXCEPTION 'You posted this game — you''re already in.' USING ERRCODE = 'P0001'; END IF;

  -- ETA only means something once the game is on; for upcoming games you arrive at start time
  IF p_eta_minutes IS NOT NULL AND g.status <> 'upcoming' THEN
    eta := now() + make_interval(mins => p_eta_minutes);
    eta_txt := CASE WHEN p_eta_minutes = 0 THEN ' — already there' ELSE ' — there in ~' || p_eta_minutes || ' min' END;
  END IF;

  SELECT * INTO existing FROM public.rsvps WHERE game_id = p_game_id AND user_id = uid;
  IF FOUND AND existing.status IN ('confirmed','waitlisted') THEN
    IF eta IS NOT NULL THEN UPDATE public.rsvps SET eta_at = eta WHERE id = existing.id; END IF;
    RETURN jsonb_build_object('status', existing.status, 'spots_open', g.spots_open, 'already', true);
  END IF;

  new_status := CASE WHEN g.spots_open > 0 THEN 'confirmed' ELSE 'waitlisted' END;

  INSERT INTO public.rsvps (user_id, game_id, status, eta_at) VALUES (uid, p_game_id, new_status, eta)
  ON CONFLICT (user_id, game_id) DO UPDATE SET status = EXCLUDED.status, eta_at = EXCLUDED.eta_at, created_at = now();

  PERFORM public._refresh_rsvp_count(p_game_id);
  SELECT spots_open INTO open_after FROM public.games WHERE id = p_game_id;

  IF new_status = 'confirmed' THEN
    UPDATE public.users SET total_rsvps = total_rsvps + 1 WHERE id = uid;
    SELECT display_name INTO me FROM public.users WHERE id = uid;
    INSERT INTO public.notifications (recipient_id, sender_id, type, game_id, title, body, data)
    VALUES (g.creator_id, uid, 'rsvp_update', p_game_id, me || ' is in 🙌' || eta_txt,
            CASE WHEN open_after > 0
                 THEN open_after || ' spot' || CASE WHEN open_after = 1 THEN '' ELSE 's' END || ' left at ' || g.location_name
                 ELSE 'Your game at ' || g.location_name || ' is full 🔥' END,
            jsonb_build_object('spots_open', open_after));
    IF open_after = 0 THEN
      INSERT INTO public.notifications (recipient_id, type, game_id, title, body)
      SELECT r.user_id, 'game_full', p_game_id, 'Game is full 🔥',
             'All spots filled for ' || g.sport || ' at ' || g.location_name || '. See you there.'
        FROM public.rsvps r WHERE r.game_id = p_game_id AND r.status = 'confirmed' AND r.user_id <> uid;
    END IF;
  END IF;

  RETURN jsonb_build_object('status', new_status, 'spots_open', open_after, 'already', false);
END $$;

-- A verified check-in at a game marks that player as arrived
CREATE OR REPLACE FUNCTION public.on_verified_checkin() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.is_verified AND NEW.game_id IS NOT NULL THEN
    UPDATE public.rsvps SET arrived_at = COALESCE(arrived_at, NEW.created_at)
     WHERE game_id = NEW.game_id AND user_id = NEW.user_id;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_checkin_arrival ON public.checkins;
CREATE TRIGGER trg_checkin_arrival AFTER INSERT ON public.checkins
  FOR EACH ROW EXECUTE FUNCTION public.on_verified_checkin();

-- ---------- 3. One game (shared links work even for ended games / far away) ----------
CREATE OR REPLACE FUNCTION public.get_game(p_game_id uuid, p_lat float8 DEFAULT NULL, p_lng float8 DEFAULT NULL)
RETURNS TABLE (
  id uuid, creator_id uuid, creator_name text, sport text, location_id uuid, location_name text,
  location_lat float8, location_lng float8, skill_level text, note text,
  total_players int, spots_needed int, spots_open int, current_rsvps int,
  game_start_time timestamptz, window_minutes int, extended_minutes int, extend_reason text,
  status public.game_status, is_verified boolean, checkin_count int, created_at timestamptz,
  distance_km numeric, friend_involved boolean, my_rsvp public.rsvp_status, score numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH me AS (SELECT auth.uid() AS uid),
  friends AS (
    SELECT CASE WHEN f.requester_id = me.uid THEN f.addressee_id ELSE f.requester_id END AS fid
      FROM public.friendships f, me
     WHERE f.status = 'accepted' AND me.uid IN (f.requester_id, f.addressee_id)),
  blocked AS (
    SELECT CASE WHEN f.requester_id = me.uid THEN f.addressee_id ELSE f.requester_id END AS bid
      FROM public.friendships f, me
     WHERE f.status = 'blocked' AND me.uid IN (f.requester_id, f.addressee_id))
  SELECT g.id, g.creator_id, u.display_name, g.sport, g.location_id, g.location_name,
         g.location_lat, g.location_lng, g.skill_level, g.note,
         g.total_players, g.spots_needed, g.spots_open, g.current_rsvps,
         g.game_start_time, g.window_minutes, g.extended_minutes, g.extend_reason,
         g.status, g.is_verified, g.checkin_count, g.created_at,
         CASE WHEN p_lat IS NULL OR p_lng IS NULL THEN NULL
              ELSE round((public.haversine_m(p_lat, p_lng, g.location_lat, g.location_lng) / 1000)::numeric, 1) END,
         (g.creator_id IN (SELECT fid FROM friends)
           OR EXISTS (SELECT 1 FROM public.rsvps r WHERE r.game_id = g.id AND r.status = 'confirmed'
                        AND r.user_id IN (SELECT fid FROM friends))),
         (SELECT r.status FROM public.rsvps r, me WHERE r.game_id = g.id AND r.user_id = me.uid),
         0::numeric
    FROM public.games g
    JOIN public.users u ON u.id = g.creator_id
   WHERE g.id = p_game_id
     AND g.creator_id NOT IN (SELECT bid FROM blocked);
$$;

-- ---------- 4. Who's coming ----------
CREATE OR REPLACE FUNCTION public.get_game_players(p_game_id uuid)
RETURNS TABLE (user_id uuid, display_name text, username text, role text,
               eta_at timestamptz, arrived boolean, joined_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT x.user_id, x.display_name, x.username, x.role, x.eta_at, x.arrived, x.joined_at
    FROM (
      SELECT g.creator_id AS user_id, u.display_name, u.username, 'host'::text AS role, NULL::timestamptz AS eta_at,
             EXISTS (SELECT 1 FROM public.checkins c
                      WHERE c.game_id = g.id AND c.user_id = g.creator_id AND c.is_verified) AS arrived,
             g.created_at AS joined_at
        FROM public.games g JOIN public.users u ON u.id = g.creator_id
       WHERE g.id = p_game_id
      UNION ALL
      SELECT r.user_id, u.display_name, u.username, r.status::text, r.eta_at,
             r.arrived_at IS NOT NULL, r.created_at
        FROM public.rsvps r JOIN public.users u ON u.id = r.user_id
       WHERE r.game_id = p_game_id AND r.status IN ('confirmed','waitlisted')
    ) x
   ORDER BY (x.role = 'host') DESC, (x.role = 'waitlisted'), x.joined_at;
$$;

-- ---------- 5. Profile card: reputation, never activity history or location ----------
CREATE OR REPLACE FUNCTION public.get_profile(p_user_id uuid)
RETURNS TABLE (user_id uuid, username text, display_name text, preferred_sports text[],
               member_since timestamptz, games_posted int, verified_checkins int, games_joined int, relation text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u.id, u.username, u.display_name, u.preferred_sports, u.created_at,
         u.total_games_posted, u.total_checkins, u.total_rsvps,
         CASE WHEN u.id = auth.uid() THEN 'me'
              ELSE COALESCE((
                SELECT CASE WHEN f.status = 'accepted' THEN 'friends'
                            WHEN f.status = 'blocked' AND f.requester_id = auth.uid() THEN 'blocked'
                            WHEN f.status = 'blocked' THEN 'none'          -- never reveal that they blocked you
                            WHEN f.requester_id = auth.uid() THEN 'requested'
                            ELSE 'incoming' END
                  FROM public.friendships f
                 WHERE LEAST(f.requester_id, f.addressee_id) = LEAST(u.id, auth.uid())
                   AND GREATEST(f.requester_id, f.addressee_id) = GREATEST(u.id, auth.uid())), 'none') END
    FROM public.users u
   WHERE u.id = p_user_id;
$$;

-- ---------- 6. Inbox ----------
CREATE OR REPLACE FUNCTION public.get_inbox(p_limit int DEFAULT 50)
RETURNS TABLE (id uuid, type public.notification_type, title text, body text, game_id uuid,
               game_status public.game_status, sender_id uuid, sender_name text, is_read boolean, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT n.id, n.type, n.title, n.body, n.game_id, g.status, n.sender_id, s.display_name, n.is_read, n.created_at
    FROM public.notifications n
    LEFT JOIN public.games g ON g.id = n.game_id
    LEFT JOIN public.users s ON s.id = n.sender_id
   WHERE n.recipient_id = auth.uid()
   ORDER BY n.created_at DESC
   LIMIT LEAST(GREATEST(p_limit, 1), 100);
$$;

-- ---------- 7. Advance posting counts calendar days ----------
CREATE OR REPLACE FUNCTION public.games_before_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s public.app_settings := public.settings();
  loc public.locations;
  active_count INTEGER;
BEGIN
  -- Serialize posts per user so two taps can't sneak past the limit
  PERFORM pg_advisory_xact_lock(hashtext(NEW.creator_id::text));

  SELECT count(*) INTO active_count FROM public.games
   WHERE creator_id = NEW.creator_id AND status IN ('upcoming','live','check');
  IF active_count >= s.max_active_posts THEN
    RAISE EXCEPTION 'You already have % active posts. End one before posting another.', active_count
      USING ERRCODE = 'P0001', HINT = 'max_active_posts';
  END IF;

  IF NEW.game_start_time < now() - interval '15 minutes' THEN
    RAISE EXCEPTION 'Game time is in the past.' USING ERRCODE = 'P0001';
  END IF;
  -- "Up to 2 days out" = through the end of the day after tomorrow (local time), not exactly 48 hours,
  -- so "In 2 days at 7 PM" works even when it's posted in the morning
  IF NEW.game_start_time >= ((date_trunc('day', now() AT TIME ZONE s.local_timezone)
                              + make_interval(days => s.max_advance_days + 1)) AT TIME ZONE s.local_timezone) THEN
    RAISE EXCEPTION 'Games can be posted at most % days ahead.', s.max_advance_days USING ERRCODE = 'P0001';
  END IF;

  -- Trust the directory's coordinates over whatever the client sent
  IF NEW.location_id IS NOT NULL THEN
    SELECT * INTO loc FROM public.locations WHERE id = NEW.location_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Unknown location.' USING ERRCODE = 'P0001'; END IF;
    NEW.location_name := loc.name; NEW.location_lat := loc.lat; NEW.location_lng := loc.lng;
  END IF;

  -- Server-controlled fields: always reset, whatever the client sent
  NEW.window_minutes := s.window_minutes;
  NEW.extended_minutes := 0; NEW.extension_count := 0; NEW.extend_reason := NULL;
  NEW.still_going_sent_at := NULL; NEW.still_going_response := NULL; NEW.still_going_responded_at := NULL;
  NEW.is_verified := false; NEW.checkin_count := 0; NEW.current_rsvps := 0; NEW.ended_at := NULL;
  NEW.status := CASE WHEN NEW.game_start_time <= now() THEN 'live' ELSE 'upcoming' END;
  NEW.created_at := now();
  RETURN NEW;
END $$;

-- ---------- Permissions (Supabase grants new functions to everyone by default — undo that) ----------
REVOKE ALL ON FUNCTION
  public.rsvp_join(uuid, int), public.on_verified_checkin(), public.get_game(uuid, float8, float8),
  public.get_game_players(uuid), public.get_profile(uuid), public.get_inbox(int)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.rsvp_join(uuid, int), public.get_game(uuid, float8, float8),
  public.get_game_players(uuid), public.get_profile(uuid), public.get_inbox(int)
TO authenticated;
GRANT EXECUTE ON FUNCTION
  public.rsvp_join(uuid, int), public.on_verified_checkin(), public.get_game(uuid, float8, float8),
  public.get_game_players(uuid), public.get_profile(uuid), public.get_inbox(int)
TO service_role;
