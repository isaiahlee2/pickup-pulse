-- ============================================================
-- PICKUP PULSE — Backend v2 (Supabase / PostgreSQL)
-- ============================================================
-- Paste into the Supabase SQL Editor on a FRESH project
-- (or run 00_reset_dev_only.sql first on your dev project).
--
-- What changed from v1:
--   * Friendships table actually creates now (v1 had a syntax error).
--   * Clients can no longer write trust data directly. Check-ins,
--     RSVPs, friend requests, and game status changes all go
--     through server-side functions (RPCs) below.
--   * Private data (home location, push token) lives in its own
--     table that only the owner can read.
--   * RSVP spot counting fixed + race-condition safe (row lock).
--   * Game lifecycle, feed ranking, predictions, and nearby-game
--     notifications run inside the database. Only push delivery
--     still needs an Edge Function (it calls an outside service).
--   * All tunable numbers live in app_settings — change them from
--     the dashboard, no redeploy.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- 0. SETTINGS (single row — edit in Table Editor to tune the app)
-- ============================================================
CREATE TABLE public.app_settings (
    id                       BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
    checkin_radius_m         INTEGER NOT NULL DEFAULT 150,
    verified_threshold       INTEGER NOT NULL DEFAULT 3,     -- unique verified check-ins to earn the badge
    window_minutes           INTEGER NOT NULL DEFAULT 120,   -- live window after game time
    extend_minutes           INTEGER NOT NULL DEFAULT 60,
    still_going_grace_min    INTEGER NOT NULL DEFAULT 5,
    max_extensions           INTEGER NOT NULL DEFAULT 1,
    max_advance_days         INTEGER NOT NULL DEFAULT 2,
    max_active_posts         INTEGER NOT NULL DEFAULT 3,     -- upcoming + live per user
    max_checkins_per_hour    INTEGER NOT NULL DEFAULT 5,
    checkin_cooldown_min     INTEGER NOT NULL DEFAULT 10,
    max_plausible_kmh        INTEGER NOT NULL DEFAULT 150,   -- faster than this between check-ins = suspicious
    feed_radius_km           INTEGER NOT NULL DEFAULT 25,
    local_timezone           TEXT    NOT NULL DEFAULT 'America/Los_Angeles',
    extend_reasons           TEXT[]  NOT NULL DEFAULT ARRAY[
                                 'Game''s still competitive 🔥',
                                 'Waiting on next game',
                                 'New players just showed up',
                                 'Running it back']
);
INSERT INTO public.app_settings DEFAULT VALUES;

CREATE OR REPLACE FUNCTION public.settings() RETURNS public.app_settings
LANGUAGE sql STABLE AS $$ SELECT * FROM public.app_settings LIMIT 1 $$;

-- Great-circle distance in meters
CREATE OR REPLACE FUNCTION public.haversine_m(lat1 float8, lng1 float8, lat2 float8, lng2 float8)
RETURNS float8 LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT 2 * 6371000 * asin(sqrt(
      sin(radians(lat2 - lat1) / 2) ^ 2
    + cos(radians(lat1)) * cos(radians(lat2)) * sin(radians(lng2 - lng1) / 2) ^ 2))
$$;

-- ============================================================
-- 1. USERS (public profile) + USER_SETTINGS (private)
-- ============================================================
CREATE TABLE public.users (
    id                  UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    username            TEXT UNIQUE NOT NULL CHECK (username ~ '^[a-zA-Z0-9_.]{2,30}$'),
    display_name        TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 50),
    avatar_url          TEXT,
    bio                 TEXT CHECK (char_length(bio) <= 200),
    preferred_sports    TEXT[] NOT NULL DEFAULT '{}',
    trust_score         INTEGER NOT NULL DEFAULT 0,
    total_checkins      INTEGER NOT NULL DEFAULT 0,
    total_games_posted  INTEGER NOT NULL DEFAULT 0,
    total_rsvps         INTEGER NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_active_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_users_sports ON public.users USING GIN (preferred_sports);
CREATE INDEX idx_users_username_lower ON public.users (lower(username));

CREATE TABLE public.user_settings (
    user_id             UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    home_lat            DOUBLE PRECISION,
    home_lng            DOUBLE PRECISION,
    push_token          TEXT,                      -- Expo push token: ExponentPushToken[...]
    platform            TEXT CHECK (platform IN ('ios','android','web')),
    notify_nearby_games BOOLEAN NOT NULL DEFAULT true,
    notify_friends      BOOLEAN NOT NULL DEFAULT true,
    notify_still_going  BOOLEAN NOT NULL DEFAULT true,
    notify_radius_km    INTEGER NOT NULL DEFAULT 8 CHECK (notify_radius_km BETWEEN 1 AND 50),
    dnd_start           TIME,                      -- local time, e.g. 22:00
    dnd_end             TIME,                      -- local time, e.g. 07:00
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Auto-create profile rows when someone signs up through Supabase Auth
CREATE OR REPLACE FUNCTION public.handle_new_auth_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE base TEXT := 'player_' || substr(md5(NEW.id::text), 1, 10);
BEGIN
  INSERT INTO public.users (id, username, display_name)
  VALUES (NEW.id, base, COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1), 'Player'))
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.user_settings (user_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_on_auth_user_created
  AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();

-- ============================================================
-- 2. LOCATIONS
-- ============================================================
CREATE TABLE public.locations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    address         TEXT,
    lat             DOUBLE PRECISION NOT NULL,
    lng             DOUBLE PRECISION NOT NULL,
    sport_types     TEXT[] NOT NULL DEFAULT '{}',
    amenities       TEXT[] NOT NULL DEFAULT '{}',
    surface_type    TEXT,
    is_indoor       BOOLEAN NOT NULL DEFAULT false,
    hours_info      TEXT,
    photo_url       TEXT,
    submitted_by    UUID REFERENCES public.users(id) ON DELETE SET NULL,
    verified        BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_locations_coords ON public.locations (lat, lng);

-- ============================================================
-- 3. GAMES
-- ============================================================
CREATE TYPE public.game_status AS ENUM ('upcoming', 'live', 'check', 'ended', 'cancelled');

CREATE TABLE public.games (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id          UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    location_id         UUID REFERENCES public.locations(id) ON DELETE SET NULL,
    sport               TEXT NOT NULL,
    location_name       TEXT NOT NULL,
    location_lat        DOUBLE PRECISION NOT NULL,
    location_lng        DOUBLE PRECISION NOT NULL,
    skill_level         TEXT NOT NULL DEFAULT 'Any' CHECK (skill_level IN ('Any','Casual','Intermediate','Competitive')),
    note                TEXT NOT NULL CHECK (char_length(note) BETWEEN 1 AND 300),

    -- Players: "have" and "need" are what the poster entered; current_rsvps counts
    -- confirmed joiners; spots_open is always derived, never edited by hand.
    total_players       INTEGER NOT NULL DEFAULT 1 CHECK (total_players BETWEEN 1 AND 60),
    spots_needed        INTEGER NOT NULL DEFAULT 0 CHECK (spots_needed BETWEEN 0 AND 60),
    current_rsvps       INTEGER NOT NULL DEFAULT 0 CHECK (current_rsvps >= 0),
    spots_open          INTEGER GENERATED ALWAYS AS (GREATEST(spots_needed - current_rsvps, 0)) STORED,

    -- Timing
    game_start_time     TIMESTAMPTZ NOT NULL,
    window_minutes      INTEGER NOT NULL DEFAULT 120,
    extended_minutes    INTEGER NOT NULL DEFAULT 0,
    extension_count     INTEGER NOT NULL DEFAULT 0,
    extend_reason       TEXT,
    still_going_sent_at TIMESTAMPTZ,
    still_going_response TEXT CHECK (still_going_response IN ('yes','no')),
    still_going_responded_at TIMESTAMPTZ,

    -- Status & trust (server-controlled)
    status              public.game_status NOT NULL DEFAULT 'upcoming',
    is_verified         BOOLEAN NOT NULL DEFAULT false,
    checkin_count       INTEGER NOT NULL DEFAULT 0,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at            TIMESTAMPTZ
);
CREATE INDEX idx_games_active ON public.games (status, game_start_time) WHERE status IN ('upcoming','live','check');
CREATE INDEX idx_games_creator ON public.games (creator_id, status);
CREATE INDEX idx_games_location ON public.games (location_id, game_start_time);

-- ============================================================
-- 4. CHECK-INS (written only by check_in())
-- ============================================================
CREATE TABLE public.checkins (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    game_id         UUID REFERENCES public.games(id) ON DELETE CASCADE,
    location_id     UUID REFERENCES public.locations(id) ON DELETE SET NULL,
    user_lat        DOUBLE PRECISION NOT NULL,
    user_lng        DOUBLE PRECISION NOT NULL,
    distance_m      INTEGER NOT NULL,
    is_verified     BOOLEAN NOT NULL,
    flagged_reason  TEXT,                        -- e.g. impossible travel speed
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_checkins_user_time ON public.checkins (user_id, created_at DESC);
CREATE INDEX idx_checkins_game ON public.checkins (game_id);
CREATE UNIQUE INDEX idx_one_checkin_per_user_per_game ON public.checkins (user_id, game_id) WHERE game_id IS NOT NULL;

-- ============================================================
-- 5. FRIENDSHIPS (v1 bug fixed: uniqueness via expression index)
-- ============================================================
CREATE TYPE public.friendship_status AS ENUM ('pending', 'accepted', 'blocked');

CREATE TABLE public.friendships (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requester_id    UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    addressee_id    UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    status          public.friendship_status NOT NULL DEFAULT 'pending',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT no_self_friendship CHECK (requester_id <> addressee_id)
);
CREATE UNIQUE INDEX idx_unique_friend_pair
  ON public.friendships (LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id));
CREATE INDEX idx_friendships_addressee ON public.friendships (addressee_id, status);

-- ============================================================
-- 6. RSVPs (written only by rsvp_join / rsvp_cancel)
-- ============================================================
CREATE TYPE public.rsvp_status AS ENUM ('confirmed', 'waitlisted', 'cancelled');

CREATE TABLE public.rsvps (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    game_id     UUID NOT NULL REFERENCES public.games(id) ON DELETE CASCADE,
    status      public.rsvp_status NOT NULL DEFAULT 'confirmed',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT unique_rsvp UNIQUE (user_id, game_id)
);
CREATE INDEX idx_rsvps_game_status ON public.rsvps (game_id, status, created_at);

-- ============================================================
-- 7. NOTIFICATIONS (in-app inbox + push queue)
-- ============================================================
CREATE TYPE public.notification_type AS ENUM (
  'nearby_game','friend_invite','friend_request','friend_accepted','still_going_ping',
  'rsvp_update','game_starting','game_verified','game_full','game_ended');

CREATE TABLE public.notifications (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_id    UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    sender_id       UUID REFERENCES public.users(id) ON DELETE SET NULL,
    type            public.notification_type NOT NULL,
    game_id         UUID REFERENCES public.games(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    body            TEXT NOT NULL,
    data            JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_read         BOOLEAN NOT NULL DEFAULT false,
    push_state      TEXT NOT NULL DEFAULT 'pending' CHECK (push_state IN ('pending','sent','skipped','failed')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_notifications_inbox ON public.notifications (recipient_id, created_at DESC);
CREATE INDEX idx_notifications_push_queue ON public.notifications (created_at) WHERE push_state = 'pending';

-- ============================================================
-- 8. REPORTS
-- ============================================================
CREATE TYPE public.report_reason AS ENUM
  ('fake_game','spam','harassment','inappropriate_content','fake_checkin','wrong_location','other');

CREATE TABLE public.reports (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter_id      UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    reported_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    reported_game_id UUID REFERENCES public.games(id) ON DELETE SET NULL,
    reason           public.report_reason NOT NULL,
    description      TEXT CHECK (char_length(description) <= 500),
    status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','reviewed','resolved','dismissed')),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT report_has_target CHECK (reported_user_id IS NOT NULL OR reported_game_id IS NOT NULL)
);

-- ============================================================
-- 9. ACTIVITY STATS (prediction engine output)
-- ============================================================
CREATE TABLE public.activity_stats (
    location_id     UUID NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
    sport           TEXT NOT NULL,
    day_of_week     SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),  -- 0 = Sunday, local time
    hour_of_day     SMALLINT NOT NULL CHECK (hour_of_day BETWEEN 0 AND 23), -- local time
    avg_games       NUMERIC(6,2) NOT NULL,
    avg_players     NUMERIC(6,2) NOT NULL,
    avg_checkins    NUMERIC(6,2) NOT NULL,
    weeks_seen      SMALLINT NOT NULL,
    confidence      SMALLINT NOT NULL CHECK (confidence BETWEEN 0 AND 95),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (location_id, sport, day_of_week, hour_of_day)
);

-- ============================================================
-- 10. updated_at triggers
-- ============================================================
CREATE OR REPLACE FUNCTION public.touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
CREATE TRIGGER trg_users_touch        BEFORE UPDATE ON public.users         FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER trg_settings_touch     BEFORE UPDATE ON public.user_settings FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER trg_games_touch        BEFORE UPDATE ON public.games         FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER trg_friendships_touch  BEFORE UPDATE ON public.friendships   FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER trg_rsvps_touch        BEFORE UPDATE ON public.rsvps         FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ============================================================
-- 11. GAME POSTING RULES (runs on every insert, no matter who sends it)
-- ============================================================
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
  IF NEW.game_start_time > now() + make_interval(days => s.max_advance_days) THEN
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
CREATE TRIGGER trg_games_before_insert BEFORE INSERT ON public.games
  FOR EACH ROW EXECUTE FUNCTION public.games_before_insert();

-- After posting: bump stats and ping nearby players who want this sport
CREATE OR REPLACE FUNCTION public.games_after_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.users SET total_games_posted = total_games_posted + 1 WHERE id = NEW.creator_id;

  INSERT INTO public.notifications (recipient_id, sender_id, type, game_id, title, body, data)
  SELECT u.id, NEW.creator_id, 'nearby_game', NEW.id,
         NEW.sport || ' nearby — need ' || NEW.spots_needed,
         left(NEW.note, 90) || ' · ' || NEW.location_name,
         jsonb_build_object('distance_km',
            round((public.haversine_m(us.home_lat, us.home_lng, NEW.location_lat, NEW.location_lng) / 1000)::numeric, 1))
    FROM public.users u
    JOIN public.user_settings us ON us.user_id = u.id
   WHERE u.id <> NEW.creator_id
     AND us.notify_nearby_games
     AND us.home_lat IS NOT NULL
     AND (cardinality(u.preferred_sports) = 0 OR NEW.sport = ANY (u.preferred_sports))
     AND public.haversine_m(us.home_lat, us.home_lng, NEW.location_lat, NEW.location_lng) <= us.notify_radius_km * 1000
     AND NOT EXISTS (SELECT 1 FROM public.friendships f      -- never notify someone you've blocked / who blocked you
                      WHERE f.status = 'blocked'
                        AND LEAST(f.requester_id, f.addressee_id) = LEAST(u.id, NEW.creator_id)
                        AND GREATEST(f.requester_id, f.addressee_id) = GREATEST(u.id, NEW.creator_id));
  RETURN NEW;
END $$;
CREATE TRIGGER trg_games_after_insert AFTER INSERT ON public.games
  FOR EACH ROW EXECUTE FUNCTION public.games_after_insert();

-- ============================================================
-- 12. RPC: CHECK IN (GPS verification — the only way to write a check-in)
-- ============================================================
CREATE OR REPLACE FUNCTION public.check_in(
  p_lat float8, p_lng float8, p_location_id uuid DEFAULT NULL, p_game_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  uid UUID := auth.uid();
  s public.app_settings := public.settings();
  g public.games;
  target_lat float8; target_lng float8; target_name TEXT; target_loc UUID;
  dist float8; last_ck public.checkins; mins float8; kmh float8;
  flagged TEXT; verified BOOLEAN; n_verified INTEGER; was_verified BOOLEAN;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Not signed in.' USING ERRCODE = '28000'; END IF;
  IF p_lat NOT BETWEEN -90 AND 90 OR p_lng NOT BETWEEN -180 AND 180 THEN
    RAISE EXCEPTION 'Invalid coordinates.' USING ERRCODE = 'P0001';
  END IF;

  IF p_game_id IS NOT NULL THEN
    SELECT * INTO g FROM public.games WHERE id = p_game_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Game not found.' USING ERRCODE = 'P0001'; END IF;
    IF g.status NOT IN ('upcoming','live','check') THEN
      RAISE EXCEPTION 'That game has ended.' USING ERRCODE = 'P0001';
    END IF;
    IF g.status = 'upcoming' AND g.game_start_time > now() + interval '30 minutes' THEN
      RAISE EXCEPTION 'Check-in opens 30 minutes before game time.' USING ERRCODE = 'P0001';
    END IF;
    target_lat := g.location_lat; target_lng := g.location_lng;
    target_name := g.location_name; target_loc := g.location_id;
  ELSIF p_location_id IS NOT NULL THEN
    SELECT lat, lng, name, id INTO target_lat, target_lng, target_name, target_loc
      FROM public.locations WHERE id = p_location_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Location not found.' USING ERRCODE = 'P0001'; END IF;
  ELSE
    RAISE EXCEPTION 'Provide a game or a location.' USING ERRCODE = 'P0001';
  END IF;

  -- Rate limit
  IF (SELECT count(*) FROM public.checkins
       WHERE user_id = uid AND created_at > now() - interval '1 hour') >= s.max_checkins_per_hour THEN
    RAISE EXCEPTION 'Too many check-ins this hour. Try again later.' USING ERRCODE = 'P0001';
  END IF;

  -- Cooldown at the same place (only for location-only check-ins; game check-ins are unique anyway)
  IF p_game_id IS NULL AND EXISTS (
      SELECT 1 FROM public.checkins WHERE user_id = uid AND location_id = target_loc
         AND created_at > now() - make_interval(mins => s.checkin_cooldown_min)) THEN
    RAISE EXCEPTION 'You checked in here recently.' USING ERRCODE = 'P0001';
  END IF;

  IF p_game_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.checkins WHERE user_id = uid AND game_id = p_game_id) THEN
    RAISE EXCEPTION 'Already checked in to this game.' USING ERRCODE = 'P0001';
  END IF;

  dist := public.haversine_m(p_lat, p_lng, target_lat, target_lng);

  -- Impossible-travel detection
  SELECT * INTO last_ck FROM public.checkins WHERE user_id = uid ORDER BY created_at DESC LIMIT 1;
  IF FOUND THEN
    mins := GREATEST(EXTRACT(EPOCH FROM (now() - last_ck.created_at)) / 60, 0.1);
    kmh  := (public.haversine_m(last_ck.user_lat, last_ck.user_lng, p_lat, p_lng) / 1000) / (mins / 60);
    IF mins < 60 AND kmh > s.max_plausible_kmh THEN
      flagged := format('impossible travel: %s km/h', round(kmh::numeric));
    END IF;
  END IF;

  verified := dist <= s.checkin_radius_m AND flagged IS NULL;

  INSERT INTO public.checkins (user_id, game_id, location_id, user_lat, user_lng, distance_m, is_verified, flagged_reason)
  VALUES (uid, p_game_id, target_loc, p_lat, p_lng, round(dist), verified, flagged);

  IF verified THEN
    UPDATE public.users SET total_checkins = total_checkins + 1, trust_score = trust_score + 1 WHERE id = uid;

    IF p_game_id IS NOT NULL THEN
      SELECT count(DISTINCT user_id) INTO n_verified
        FROM public.checkins WHERE game_id = p_game_id AND is_verified;
      was_verified := g.is_verified;
      UPDATE public.games
         SET checkin_count = n_verified,
             is_verified   = is_verified OR n_verified >= s.verified_threshold
       WHERE id = p_game_id;
      IF NOT was_verified AND n_verified >= s.verified_threshold THEN
        INSERT INTO public.notifications (recipient_id, type, game_id, title, body)
        VALUES (g.creator_id, 'game_verified', p_game_id, 'Your game is verified ✓',
                n_verified || ' players checked in at ' || g.location_name || '.');
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'verified', verified,
    'distance_m', round(dist),
    'radius_m', s.checkin_radius_m,
    'message', CASE
      WHEN verified THEN 'Checked in at ' || target_name || ' ✅'
      WHEN flagged IS NOT NULL THEN 'We couldn''t verify your location. Try again in a bit.'
      ELSE 'You''re ' || round(dist) || 'm away — get within ' || s.checkin_radius_m || 'm.'
    END);
END $$;

-- ============================================================
-- 13. RPC: RSVP JOIN / CANCEL (atomic — row lock prevents double-booking the last spot)
-- ============================================================
CREATE OR REPLACE FUNCTION public._refresh_rsvp_count(p_game_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.games SET current_rsvps =
    (SELECT count(*) FROM public.rsvps WHERE game_id = p_game_id AND status = 'confirmed')
  WHERE id = p_game_id;
$$;

CREATE OR REPLACE FUNCTION public.rsvp_join(p_game_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  uid UUID := auth.uid(); g public.games; existing public.rsvps; new_status public.rsvp_status;
  me TEXT; open_after INTEGER;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Not signed in.' USING ERRCODE = '28000'; END IF;
  SELECT * INTO g FROM public.games WHERE id = p_game_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Game not found.' USING ERRCODE = 'P0001'; END IF;
  IF g.status NOT IN ('upcoming','live','check') THEN RAISE EXCEPTION 'That game has ended.' USING ERRCODE = 'P0001'; END IF;
  IF g.creator_id = uid THEN RAISE EXCEPTION 'You posted this game — you''re already in.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO existing FROM public.rsvps WHERE game_id = p_game_id AND user_id = uid;
  IF FOUND AND existing.status IN ('confirmed','waitlisted') THEN
    RETURN jsonb_build_object('status', existing.status, 'spots_open', g.spots_open, 'already', true);
  END IF;

  new_status := CASE WHEN g.spots_open > 0 THEN 'confirmed' ELSE 'waitlisted' END;

  INSERT INTO public.rsvps (user_id, game_id, status) VALUES (uid, p_game_id, new_status)
  ON CONFLICT (user_id, game_id) DO UPDATE SET status = EXCLUDED.status, created_at = now();

  PERFORM public._refresh_rsvp_count(p_game_id);
  SELECT spots_open INTO open_after FROM public.games WHERE id = p_game_id;

  IF new_status = 'confirmed' THEN
    UPDATE public.users SET total_rsvps = total_rsvps + 1 WHERE id = uid;
    SELECT display_name INTO me FROM public.users WHERE id = uid;
    INSERT INTO public.notifications (recipient_id, sender_id, type, game_id, title, body, data)
    VALUES (g.creator_id, uid, 'rsvp_update', p_game_id, me || ' is in 🙌',
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

CREATE OR REPLACE FUNCTION public.rsvp_cancel(p_game_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  uid UUID := auth.uid(); g public.games; existing public.rsvps; promoted UUID; me TEXT;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Not signed in.' USING ERRCODE = '28000'; END IF;
  SELECT * INTO g FROM public.games WHERE id = p_game_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Game not found.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO existing FROM public.rsvps WHERE game_id = p_game_id AND user_id = uid;
  IF NOT FOUND OR existing.status = 'cancelled' THEN
    RETURN jsonb_build_object('status', 'cancelled', 'promoted', false);
  END IF;

  UPDATE public.rsvps SET status = 'cancelled' WHERE id = existing.id;

  IF existing.status = 'confirmed' THEN
    -- Oldest waitlisted player takes the spot
    UPDATE public.rsvps SET status = 'confirmed'
     WHERE id = (SELECT id FROM public.rsvps WHERE game_id = p_game_id AND status = 'waitlisted'
                  ORDER BY created_at LIMIT 1)
    RETURNING user_id INTO promoted;

    IF promoted IS NOT NULL THEN
      INSERT INTO public.notifications (recipient_id, type, game_id, title, body)
      VALUES (promoted, 'rsvp_update', p_game_id, 'A spot opened up 🎉',
              'You''re off the waitlist for ' || g.sport || ' at ' || g.location_name || '.');
    END IF;

    SELECT display_name INTO me FROM public.users WHERE id = uid;
    INSERT INTO public.notifications (recipient_id, sender_id, type, game_id, title, body)
    VALUES (g.creator_id, uid, 'rsvp_update', p_game_id, me || ' dropped out',
            CASE WHEN promoted IS NOT NULL THEN 'A waitlisted player took the spot.'
                 ELSE 'A spot opened up at ' || g.location_name || '.' END);
  END IF;

  PERFORM public._refresh_rsvp_count(p_game_id);
  RETURN jsonb_build_object('status', 'cancelled', 'promoted', promoted IS NOT NULL);
END $$;

-- ============================================================
-- 14. RPC: STILL GOING? / END GAME
-- ============================================================
CREATE OR REPLACE FUNCTION public.respond_still_going(p_game_id uuid, p_action text, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE uid UUID := auth.uid(); s public.app_settings := public.settings(); g public.games;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Not signed in.' USING ERRCODE = '28000'; END IF;
  SELECT * INTO g FROM public.games WHERE id = p_game_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Game not found.' USING ERRCODE = 'P0001'; END IF;
  IF g.creator_id <> uid THEN RAISE EXCEPTION 'Only the poster can respond.' USING ERRCODE = '42501'; END IF;
  IF g.status <> 'check' THEN RAISE EXCEPTION 'This game isn''t waiting on a response.' USING ERRCODE = 'P0001'; END IF;

  IF now() > g.still_going_sent_at + make_interval(mins => s.still_going_grace_min) THEN
    UPDATE public.games SET status = 'ended', still_going_response = 'no',
           still_going_responded_at = now(), ended_at = now() WHERE id = p_game_id;
    RETURN jsonb_build_object('status', 'ended', 'message', 'Response window closed — game ended.');
  END IF;

  IF p_action = 'end' THEN
    UPDATE public.games SET status = 'ended', still_going_response = 'no',
           still_going_responded_at = now(), ended_at = now() WHERE id = p_game_id;
    RETURN jsonb_build_object('status', 'ended', 'message', 'Game ended. Thanks for keeping the feed accurate.');
  ELSIF p_action = 'extend' THEN
    IF p_reason IS NULL OR NOT (p_reason = ANY (s.extend_reasons)) THEN
      RAISE EXCEPTION 'Pick a reason to extend.' USING ERRCODE = 'P0001', DETAIL = array_to_string(s.extend_reasons, ' | ');
    END IF;
    IF g.extension_count >= s.max_extensions THEN
      RAISE EXCEPTION 'This game has already been extended.' USING ERRCODE = 'P0001';
    END IF;
    UPDATE public.games
       SET status = 'live', still_going_response = 'yes', still_going_responded_at = now(),
           still_going_sent_at = NULL,                           -- re-arms the next "still going?" check
           extended_minutes = extended_minutes + s.extend_minutes,
           extension_count = extension_count + 1, extend_reason = p_reason
     WHERE id = p_game_id;
    INSERT INTO public.notifications (recipient_id, sender_id, type, game_id, title, body)
    SELECT r.user_id, uid, 'rsvp_update', p_game_id, 'Still going 🔥',
           g.sport || ' at ' || g.location_name || ' extended +' || s.extend_minutes || ' min: ' || p_reason
      FROM public.rsvps r WHERE r.game_id = p_game_id AND r.status = 'confirmed';
    RETURN jsonb_build_object('status', 'live', 'extended_minutes', s.extend_minutes, 'reason', p_reason);
  ELSE
    RAISE EXCEPTION 'Action must be extend or end.' USING ERRCODE = 'P0001';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.end_game(p_game_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE uid UUID := auth.uid(); g public.games;
BEGIN
  SELECT * INTO g FROM public.games WHERE id = p_game_id FOR UPDATE;
  IF NOT FOUND OR g.creator_id IS DISTINCT FROM uid THEN
    RAISE EXCEPTION 'Only the poster can end this game.' USING ERRCODE = '42501';
  END IF;
  IF g.status IN ('ended','cancelled') THEN RETURN jsonb_build_object('status', g.status); END IF;
  UPDATE public.games
     SET status = CASE WHEN g.status = 'upcoming' THEN 'cancelled'::public.game_status ELSE 'ended' END,
         ended_at = now()
   WHERE id = p_game_id;
  IF g.status = 'upcoming' THEN
    INSERT INTO public.notifications (recipient_id, type, game_id, title, body)
    SELECT r.user_id, 'game_ended', p_game_id, 'Game cancelled',
           g.sport || ' at ' || g.location_name || ' was called off.'
      FROM public.rsvps r WHERE r.game_id = p_game_id AND r.status IN ('confirmed','waitlisted');
  END IF;
  RETURN jsonb_build_object('status', CASE WHEN g.status = 'upcoming' THEN 'cancelled' ELSE 'ended' END);
END $$;

-- ============================================================
-- 15. LIFECYCLE TICK — pg_cron runs this every minute
--     (p_now is only there so tests can "time travel")
-- ============================================================
CREATE OR REPLACE FUNCTION public.tick_game_lifecycle(p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE s public.app_settings := public.settings(); n_live INT; n_check INT; n_noresp INT; n_ext INT;
BEGIN
  -- upcoming → live
  WITH moved AS (
    UPDATE public.games SET status = 'live' WHERE status = 'upcoming' AND game_start_time <= p_now
    RETURNING id, creator_id, sport, location_name)
  , notified AS (
    INSERT INTO public.notifications (recipient_id, type, game_id, title, body)
    SELECT m.creator_id, 'game_starting'::public.notification_type, m.id, 'Your game is live 🟢', m.sport || ' at ' || m.location_name || ' is on the feed now.' FROM moved m
    UNION ALL
    SELECT r.user_id, 'game_starting'::public.notification_type, m.id, 'Game time 🟢', m.sport || ' at ' || m.location_name || ' is starting.'
      FROM moved m JOIN public.rsvps r ON r.game_id = m.id AND r.status = 'confirmed'
    RETURNING 1)
  SELECT count(*) INTO n_live FROM moved;

  -- live → check (window used up, ask "still going?")
  WITH moved AS (
    UPDATE public.games SET status = 'check', still_going_sent_at = p_now
     WHERE status = 'live' AND still_going_sent_at IS NULL
       AND extension_count < s.max_extensions
       AND p_now >= game_start_time + make_interval(mins => window_minutes + extended_minutes)
    RETURNING id, creator_id, sport, location_name, window_minutes + extended_minutes AS mins)
  , notified AS (
    INSERT INTO public.notifications (recipient_id, type, game_id, title, body, data)
    SELECT creator_id, 'still_going_ping'::public.notification_type, id, '⏰ Still going?',
           sport || ' at ' || location_name || ' hit ' || mins || ' min. Extend or end it?',
           jsonb_build_object('action', 'still_going_prompt')
      FROM moved RETURNING 1)
  SELECT count(*) INTO n_check FROM moved;

  -- live → ended (out of extensions and time)
  UPDATE public.games SET status = 'ended', ended_at = p_now
   WHERE status = 'live' AND extension_count >= s.max_extensions
     AND p_now >= game_start_time + make_interval(mins => window_minutes + extended_minutes);
  GET DIAGNOSTICS n_ext = ROW_COUNT;

  -- check → ended (no answer inside the grace period)
  UPDATE public.games SET status = 'ended', still_going_response = 'no', ended_at = p_now
   WHERE status = 'check'
     AND p_now >= still_going_sent_at + make_interval(mins => s.still_going_grace_min);
  GET DIAGNOSTICS n_noresp = ROW_COUNT;

  RETURN jsonb_build_object('to_live', n_live, 'to_check', n_check,
                            'ended_no_response', n_noresp, 'ended_after_extension', n_ext);
END $$;

-- ============================================================
-- 16. RPC: RANKED FEED
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_feed(p_lat float8, p_lng float8, p_sport text DEFAULT NULL, p_limit int DEFAULT 50)
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
     WHERE f.status = 'blocked' AND me.uid IN (f.requester_id, f.addressee_id)),
  prefs AS (SELECT u.preferred_sports FROM public.users u, me WHERE u.id = me.uid),
  base AS (
    SELECT g.*, u.display_name AS creator_name,
           public.haversine_m(p_lat, p_lng, g.location_lat, g.location_lng) / 1000 AS dkm,
           (g.creator_id IN (SELECT fid FROM friends)
             OR EXISTS (SELECT 1 FROM public.rsvps r WHERE r.game_id = g.id AND r.status = 'confirmed'
                          AND r.user_id IN (SELECT fid FROM friends))) AS friend_in,
           (SELECT r.status FROM public.rsvps r, me WHERE r.game_id = g.id AND r.user_id = me.uid) AS mine
      FROM public.games g
      JOIN public.users u ON u.id = g.creator_id
     WHERE g.status IN ('upcoming','live','check')
       AND (p_sport IS NULL OR p_sport = 'All' OR g.sport = p_sport)
       AND g.creator_id NOT IN (SELECT bid FROM blocked))
  SELECT b.id, b.creator_id, b.creator_name, b.sport, b.location_id, b.location_name,
         b.location_lat, b.location_lng, b.skill_level, b.note,
         b.total_players, b.spots_needed, b.spots_open, b.current_rsvps,
         b.game_start_time, b.window_minutes, b.extended_minutes, b.extend_reason,
         b.status, b.is_verified, b.checkin_count, b.created_at,
         round(b.dkm::numeric, 1), b.friend_in, b.mine,
         round((
             30 * GREATEST(0, 1 - b.dkm / (SELECT feed_radius_km FROM public.settings()))   -- proximity
           + 20 * LEAST(1, ln(b.checkin_count + 1) / ln(11))                               -- check-ins (log)
           + 15 * b.is_verified::int                                                       -- verified
           + 15 * b.friend_in::int                                                         -- friends
           + 10 * (b.sport = ANY (COALESCE((SELECT preferred_sports FROM prefs), '{}')))::int
           + 10 * GREATEST(0, 1 - EXTRACT(EPOCH FROM (now() - b.created_at)) / 14400)      -- recency (4h decay)
         )::numeric, 1) AS score
    FROM base b
   WHERE b.dkm <= (SELECT feed_radius_km FROM public.settings())
   ORDER BY CASE b.status WHEN 'live' THEN 0 WHEN 'check' THEN 1 ELSE 2 END,
            CASE WHEN b.status = 'upcoming' THEN b.game_start_time END ASC NULLS LAST,
            score DESC
   LIMIT LEAST(p_limit, 100);
$$;

-- ============================================================
-- 17. PREDICTIONS — pg_cron runs this nightly
--     Uses LOCAL time (a 6 PM run in Corvallis is 1 AM UTC the next day —
--     bucketing in UTC would put Tuesday runs on Wednesday).
-- ============================================================
CREATE OR REPLACE FUNCTION public.refresh_activity_stats(p_now timestamptz DEFAULT now())
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE s public.app_settings := public.settings(); n INTEGER;
BEGIN
  DELETE FROM public.activity_stats;
  WITH src AS (
    SELECT g.location_id, g.sport,
           (g.game_start_time AT TIME ZONE s.local_timezone) AS local_ts,
           g.total_players + g.current_rsvps AS players, g.checkin_count,
           floor(EXTRACT(EPOCH FROM (p_now - g.game_start_time)) / 604800)::int AS week_idx
      FROM public.games g
     WHERE g.location_id IS NOT NULL
       AND g.game_start_time BETWEEN p_now - interval '28 days' AND p_now
       AND g.status IN ('live','check','ended')
       AND (g.checkin_count > 0 OR g.current_rsvps > 0)   -- only games that actually drew people
  ), agg AS (
    SELECT location_id, sport,
           EXTRACT(DOW FROM local_ts)::smallint AS dow, EXTRACT(HOUR FROM local_ts)::smallint AS hr,
           count(*) AS games, sum(players) AS players, sum(checkin_count) AS checkins,
           count(DISTINCT week_idx) AS weeks
      FROM src GROUP BY 1, 2, 3, 4)
  INSERT INTO public.activity_stats
    (location_id, sport, day_of_week, hour_of_day, avg_games, avg_players, avg_checkins, weeks_seen, confidence)
  SELECT location_id, sport, dow, hr,
         round(games / 4.0, 2), round(players / 4.0, 2), round(checkins / 4.0, 2), weeks,
         LEAST(95, round(60 * (weeks / 4.0) + 35 * LEAST(1, (checkins / 4.0) / 5) + CASE WHEN games > 4 THEN 5 ELSE 0 END))
    FROM agg WHERE weeks >= 2;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION public.get_trends(p_sport text DEFAULT NULL)
RETURNS TABLE (location_id uuid, location_name text, sport text, day_of_week smallint,
               hour_of_day smallint, avg_players numeric, confidence smallint)
LANGUAGE sql STABLE AS $$
  SELECT a.location_id, l.name, a.sport, a.day_of_week, a.hour_of_day, a.avg_players, a.confidence
    FROM public.activity_stats a JOIN public.locations l ON l.id = a.location_id
   WHERE p_sport IS NULL OR p_sport = 'All' OR a.sport = p_sport
   ORDER BY a.confidence DESC, a.avg_players DESC
   LIMIT 200;
$$;

-- ============================================================
-- 18. FRIENDS
-- ============================================================
CREATE OR REPLACE FUNCTION public.send_friend_request(p_username text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE uid UUID := auth.uid(); target UUID; existing public.friendships; me TEXT;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Not signed in.' USING ERRCODE = '28000'; END IF;
  SELECT id INTO target FROM public.users WHERE lower(username) = lower(p_username);
  IF target IS NULL THEN RAISE EXCEPTION 'No player with that username.' USING ERRCODE = 'P0001'; END IF;
  IF target = uid THEN RAISE EXCEPTION 'That''s you.' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO existing FROM public.friendships
   WHERE LEAST(requester_id, addressee_id) = LEAST(uid, target)
     AND GREATEST(requester_id, addressee_id) = GREATEST(uid, target);
  IF FOUND THEN
    IF existing.status = 'blocked' THEN RAISE EXCEPTION 'Can''t send a request to this player.' USING ERRCODE = 'P0001'; END IF;
    -- They already asked you → accept instead of duplicating
    IF existing.status = 'pending' AND existing.addressee_id = uid THEN
      UPDATE public.friendships SET status = 'accepted' WHERE id = existing.id;
      RETURN jsonb_build_object('status', 'accepted');
    END IF;
    RETURN jsonb_build_object('status', existing.status);
  END IF;

  INSERT INTO public.friendships (requester_id, addressee_id) VALUES (uid, target);
  SELECT display_name INTO me FROM public.users WHERE id = uid;
  INSERT INTO public.notifications (recipient_id, sender_id, type, title, body)
  VALUES (target, uid, 'friend_request', 'New crew request', me || ' wants to add you.');
  RETURN jsonb_build_object('status', 'pending');
END $$;

CREATE OR REPLACE FUNCTION public.respond_friend_request(p_friendship_id uuid, p_accept boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE uid UUID := auth.uid(); f public.friendships; me TEXT;
BEGIN
  SELECT * INTO f FROM public.friendships WHERE id = p_friendship_id FOR UPDATE;
  IF NOT FOUND OR f.addressee_id IS DISTINCT FROM uid OR f.status <> 'pending' THEN
    RAISE EXCEPTION 'No pending request to answer.' USING ERRCODE = 'P0001';
  END IF;
  IF p_accept THEN
    UPDATE public.friendships SET status = 'accepted' WHERE id = f.id;
    SELECT display_name INTO me FROM public.users WHERE id = uid;
    INSERT INTO public.notifications (recipient_id, sender_id, type, title, body)
    VALUES (f.requester_id, uid, 'friend_accepted', 'Added to your crew', me || ' accepted your request.');
    RETURN jsonb_build_object('status', 'accepted');
  END IF;
  DELETE FROM public.friendships WHERE id = f.id;
  RETURN jsonb_build_object('status', 'declined');
END $$;

CREATE OR REPLACE FUNCTION public.remove_or_block_friend(p_user_id uuid, p_block boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE uid UUID := auth.uid();
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Not signed in.' USING ERRCODE = '28000'; END IF;
  DELETE FROM public.friendships
   WHERE LEAST(requester_id, addressee_id) = LEAST(uid, p_user_id)
     AND GREATEST(requester_id, addressee_id) = GREATEST(uid, p_user_id);
  IF p_block THEN
    INSERT INTO public.friendships (requester_id, addressee_id, status) VALUES (uid, p_user_id, 'blocked');
  END IF;
  RETURN jsonb_build_object('status', CASE WHEN p_block THEN 'blocked' ELSE 'removed' END);
END $$;

-- The Crew screen: friends + pending requests in one call
CREATE OR REPLACE FUNCTION public.get_crew()
RETURNS TABLE (friendship_id uuid, user_id uuid, username text, display_name text, avatar_url text,
               preferred_sports text[], status public.friendship_status, incoming boolean,
               active_game_id uuid, active_game_label text, last_active_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT f.id, u.id, u.username, u.display_name, u.avatar_url, u.preferred_sports, f.status,
         (f.addressee_id = auth.uid() AND f.status = 'pending'),
         ag.id, ag.label, u.last_active_at
    FROM public.friendships f
    JOIN public.users u ON u.id = CASE WHEN f.requester_id = auth.uid() THEN f.addressee_id ELSE f.requester_id END
    LEFT JOIN LATERAL (   -- what are they up to? (only shown to accepted friends)
      SELECT g.id, CASE WHEN g.creator_id = u.id THEN 'Posted ' ELSE 'In on ' END
                   || g.sport || ' at ' || g.location_name AS label
        FROM public.games g
       WHERE f.status = 'accepted' AND g.status IN ('upcoming','live','check')
         AND (g.creator_id = u.id OR EXISTS (SELECT 1 FROM public.rsvps r
                WHERE r.game_id = g.id AND r.user_id = u.id AND r.status = 'confirmed'))
       ORDER BY g.game_start_time LIMIT 1) ag ON true
   WHERE auth.uid() IN (f.requester_id, f.addressee_id) AND f.status <> 'blocked'
   ORDER BY (f.addressee_id = auth.uid() AND f.status = 'pending') DESC, ag.id IS NULL, u.display_name;
$$;

CREATE OR REPLACE FUNCTION public.invite_friends(p_game_id uuid, p_friend_ids uuid[], p_message text DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE uid UUID := auth.uid(); g public.games; me TEXT; n INTEGER;
BEGIN
  SELECT * INTO g FROM public.games WHERE id = p_game_id AND status IN ('upcoming','live','check');
  IF NOT FOUND THEN RAISE EXCEPTION 'Game not found or ended.' USING ERRCODE = 'P0001'; END IF;
  SELECT display_name INTO me FROM public.users WHERE id = uid;
  INSERT INTO public.notifications (recipient_id, sender_id, type, game_id, title, body)
  SELECT fid, uid, 'friend_invite', p_game_id, me || ' wants you to pull up 👀',
         COALESCE(NULLIF(left(p_message, 140), ''), g.sport || ' at ' || g.location_name)
    FROM unnest(p_friend_ids) AS fid
   WHERE EXISTS (SELECT 1 FROM public.friendships f WHERE f.status = 'accepted'
                   AND LEAST(f.requester_id, f.addressee_id) = LEAST(uid, fid)
                   AND GREATEST(f.requester_id, f.addressee_id) = GREATEST(uid, fid));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;   -- only actual friends get it; strangers are silently skipped
END $$;

-- ============================================================
-- 19. PUSH QUEUE — the send-push Edge Function calls this, then posts to Expo
--     Applies preferences + do-not-disturb, and claims rows so two
--     overlapping runs never double-send (SKIP LOCKED).
-- ============================================================
CREATE OR REPLACE FUNCTION public.claim_push_batch(p_limit int DEFAULT 100, p_now timestamptz DEFAULT now())
RETURNS TABLE (notification_id uuid, push_token text, title text, body text, data jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE s public.app_settings := public.settings(); local_t time := (p_now AT TIME ZONE s.local_timezone)::time;
BEGIN
  RETURN QUERY
  WITH batch AS (
    SELECT n.id FROM public.notifications n
     WHERE n.push_state = 'pending' AND n.created_at > p_now - interval '1 hour'  -- stale pushes are noise
     ORDER BY n.created_at
     LIMIT p_limit FOR UPDATE SKIP LOCKED),
  decided AS (
    SELECT n.id, us.push_token AS tok, n.title AS t, n.body AS b,
           n.data || jsonb_build_object('notification_id', n.id, 'type', n.type, 'game_id', n.game_id) AS d,
           (us.push_token IS NOT NULL
            AND CASE n.type
                  WHEN 'nearby_game'      THEN us.notify_nearby_games
                  WHEN 'friend_invite'    THEN us.notify_friends
                  WHEN 'friend_request'   THEN us.notify_friends
                  WHEN 'friend_accepted'  THEN us.notify_friends
                  WHEN 'still_going_ping' THEN us.notify_still_going
                  ELSE true END
            AND NOT (n.type <> 'still_going_ping'          -- your own game's ping ignores DND
                     AND us.dnd_start IS NOT NULL AND us.dnd_end IS NOT NULL
                     AND CASE WHEN us.dnd_start <= us.dnd_end
                              THEN local_t BETWEEN us.dnd_start AND us.dnd_end
                              ELSE local_t >= us.dnd_start OR local_t <= us.dnd_end END)
           ) AS send
      FROM public.notifications n
      JOIN batch ON batch.id = n.id
      LEFT JOIN public.user_settings us ON us.user_id = n.recipient_id),
  marked AS (
    UPDATE public.notifications n SET push_state = CASE WHEN d.send THEN 'sent' ELSE 'skipped' END
      FROM decided d WHERE n.id = d.id RETURNING n.id)
  SELECT d.id, d.tok, d.t, d.b, d.d FROM decided d WHERE d.send;
END $$;

CREATE OR REPLACE FUNCTION public.mark_push_failed(p_ids uuid[]) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.notifications SET push_state = 'failed' WHERE id = ANY (p_ids);
$$;

-- Expo tells us when a token is dead (app uninstalled) — stop sending to it
CREATE OR REPLACE FUNCTION public.clear_push_tokens(p_tokens text[]) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.user_settings SET push_token = NULL WHERE push_token = ANY (p_tokens);
$$;

-- ============================================================
-- 20. PERMISSIONS — the security fix
--     Default Supabase grants let any signed-in user write any column
--     their RLS row policy allows. We revoke that and grant back only
--     the columns users should control. Everything trust-related goes
--     through the SECURITY DEFINER functions above.
-- ============================================================
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated, PUBLIC;

-- Read access
GRANT SELECT ON public.users, public.locations, public.games, public.rsvps, public.activity_stats, public.app_settings TO authenticated;
GRANT SELECT ON public.user_settings, public.notifications, public.checkins, public.friendships, public.reports TO authenticated;

-- Write access, column by column
GRANT UPDATE (username, display_name, avatar_url, bio, preferred_sports, last_active_at) ON public.users TO authenticated;
GRANT UPDATE (home_lat, home_lng, push_token, platform, notify_nearby_games, notify_friends,
              notify_still_going, notify_radius_km, dnd_start, dnd_end) ON public.user_settings TO authenticated;
GRANT INSERT (creator_id, location_id, sport, location_name, location_lat, location_lng, skill_level,
              note, total_players, spots_needed, game_start_time) ON public.games TO authenticated;
GRANT UPDATE (note, skill_level, total_players, spots_needed) ON public.games TO authenticated;
GRANT UPDATE (is_read) ON public.notifications TO authenticated;
GRANT INSERT (reporter_id, reported_user_id, reported_game_id, reason, description) ON public.reports TO authenticated;
GRANT INSERT (name, address, lat, lng, sport_types, amenities, surface_type, is_indoor, hours_info, submitted_by) ON public.locations TO authenticated;

-- Callable functions (app-facing)
GRANT EXECUTE ON FUNCTION
  public.check_in(float8, float8, uuid, uuid),
  public.rsvp_join(uuid), public.rsvp_cancel(uuid),
  public.respond_still_going(uuid, text, text), public.end_game(uuid),
  public.get_feed(float8, float8, text, int), public.get_trends(text),
  public.send_friend_request(text), public.respond_friend_request(uuid, boolean),
  public.remove_or_block_friend(uuid, boolean), public.get_crew(),
  public.invite_friends(uuid, uuid[], text),
  public.haversine_m(float8, float8, float8, float8), public.settings()
TO authenticated;
-- tick_game_lifecycle, refresh_activity_stats, claim_push_batch, mark_push_failed,
-- clear_push_tokens: service role / pg_cron only. Not callable from the app.
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;

-- ============================================================
-- 21. ROW LEVEL SECURITY (which ROWS; the grants above control which COLUMNS)
-- ============================================================
ALTER TABLE public.app_settings   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_settings  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.locations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.games          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checkins       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.friendships    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rsvps          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reports        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_stats ENABLE ROW LEVEL SECURITY;

CREATE POLICY settings_read ON public.app_settings  FOR SELECT TO authenticated USING (true);
CREATE POLICY users_read    ON public.users         FOR SELECT TO authenticated USING (true);
CREATE POLICY users_update  ON public.users         FOR UPDATE TO authenticated USING (id = auth.uid()) WITH CHECK (id = auth.uid());
CREATE POLICY us_read       ON public.user_settings FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY us_update     ON public.user_settings FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY loc_read      ON public.locations     FOR SELECT TO authenticated USING (true);
CREATE POLICY loc_insert    ON public.locations     FOR INSERT TO authenticated WITH CHECK (submitted_by = auth.uid());
CREATE POLICY games_read    ON public.games         FOR SELECT TO authenticated USING (true);
CREATE POLICY games_insert  ON public.games         FOR INSERT TO authenticated WITH CHECK (creator_id = auth.uid());
CREATE POLICY games_update  ON public.games         FOR UPDATE TO authenticated
  USING (creator_id = auth.uid() AND status IN ('upcoming','live','check')) WITH CHECK (creator_id = auth.uid());
-- Check-ins store raw GPS — only you can see your own history (stalking protection)
CREATE POLICY ck_read_own   ON public.checkins      FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY fr_read       ON public.friendships   FOR SELECT TO authenticated USING (auth.uid() IN (requester_id, addressee_id));
CREATE POLICY rsvp_read     ON public.rsvps         FOR SELECT TO authenticated USING (true);
CREATE POLICY notif_read    ON public.notifications FOR SELECT TO authenticated USING (recipient_id = auth.uid());
CREATE POLICY notif_update  ON public.notifications FOR UPDATE TO authenticated USING (recipient_id = auth.uid()) WITH CHECK (recipient_id = auth.uid());
CREATE POLICY rep_insert    ON public.reports       FOR INSERT TO authenticated WITH CHECK (reporter_id = auth.uid());
CREATE POLICY rep_read_own  ON public.reports       FOR SELECT TO authenticated USING (reporter_id = auth.uid());
CREATE POLICY stats_read    ON public.activity_stats FOR SELECT TO authenticated USING (true);

-- ============================================================
-- 22. REALTIME (the app subscribes to these for live updates)
-- ============================================================
ALTER PUBLICATION supabase_realtime ADD TABLE public.games, public.rsvps, public.notifications;

-- ============================================================
-- 23. SEED — Corvallis locations
-- ============================================================
INSERT INTO public.locations (name, address, lat, lng, sport_types, amenities, surface_type, is_indoor, verified) VALUES
  ('Highland Park Courts',   'Highland Dr, Corvallis, OR',       44.5705, -123.2680, '{Basketball}',                 '{outdoor,lights}',             'asphalt',  false, true),
  ('Dixon Rec Center',       '425 SW 26th St, Corvallis, OR',    44.5633, -123.2794, '{Basketball,Volleyball}',      '{indoor,water,locker_rooms}',  'hardwood', true,  true),
  ('OSU Intramural Fields',  'SW Western Blvd, Corvallis, OR',   44.5590, -123.2810, '{Football,Soccer,Softball}',   '{outdoor,lights,parking}',     'grass',    false, true),
  ('McAlexander Fieldhouse', 'SW 26th St, Corvallis, OR',        44.5612, -123.2756, '{Basketball,Volleyball}',      '{indoor}',                     'hardwood', true,  true),
  ('Sunset Park',            'NW Sunset Dr, Corvallis, OR',      44.5820, -123.2590, '{Basketball}',                 '{outdoor,lights}',             'asphalt',  false, true),
  ('Riverfront Fields',      'NW 1st St, Corvallis, OR',         44.5672, -123.2615, '{Soccer,Football}',            '{outdoor,parking}',            'grass',    false, true),
  ('Willamette Park',        'SE Goodnight Ave, Corvallis, OR',  44.5540, -123.2640, '{Volleyball,Tennis}',          '{outdoor,sand_courts}',        'sand',     false, true),
  ('Pioneer Park',           'NE Baker St, Corvallis, OR',       44.5660, -123.2520, '{Tennis,Basketball}',          '{outdoor,lights}',             'asphalt',  false, true);
-- ⚠️ These coordinates are approximate. Before beta, stand at each court,
-- drop a pin in Google Maps, and update lat/lng — a 150 m radius is unforgiving.
