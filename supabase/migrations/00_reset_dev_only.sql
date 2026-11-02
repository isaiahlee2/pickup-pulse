-- ============================================================
-- ⚠️  DEV ONLY — wipes every Pickup Pulse table and function (v1 or v2)
-- so 01_schema_v2.sql can be applied cleanly. Deletes all app data.
-- Does NOT touch Supabase Auth accounts.
-- ============================================================
DROP TRIGGER IF EXISTS trg_on_auth_user_created ON auth.users;
DROP TABLE IF EXISTS public.activity_stats, public.reports, public.notifications, public.rsvps,
  public.friendships, public.checkins, public.games, public.locations, public.user_settings,
  public.users, public.app_settings CASCADE;
DROP TYPE IF EXISTS public.game_status, public.friendship_status, public.rsvp_status,
  public.notification_type, public.report_status, public.report_reason CASCADE;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS sig FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            LEFT JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e'   -- skip extension functions
           WHERE n.nspname = 'public' AND d.objid IS NULL
  LOOP EXECUTE 'DROP FUNCTION IF EXISTS ' || r.sig || ' CASCADE'; END LOOP;
END $$;
