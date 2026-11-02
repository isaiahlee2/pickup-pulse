-- ============================================================
-- PICKUP PULSE — scheduled jobs (run AFTER 01_schema_v2.sql)
-- Before running: Dashboard → Database → Extensions → enable pg_cron and pg_net.
-- Replace YOUR_PROJECT_REF and YOUR_CRON_SECRET below.
-- ============================================================
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- See what's already scheduled (your earlier every-minute job will show here).
-- If it calls the old game-lifecycle Edge Function, remove it:
--   SELECT cron.unschedule(<jobid from the list>);
SELECT jobid, jobname, schedule, command FROM cron.job;

-- Clear previous versions of these jobs so this file is safe to re-run
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname LIKE 'pp-%';

-- Every minute: move games through upcoming → live → "still going?" → ended
SELECT cron.schedule('pp-lifecycle', '* * * * *', $$SELECT public.tick_game_lifecycle()$$);

-- Nightly at 11:00 UTC (≈ 3–4 AM Pacific): rebuild "usually busy" predictions
SELECT cron.schedule('pp-activity-stats', '0 11 * * *', $$SELECT public.refresh_activity_stats()$$);

-- Every minute: deliver queued push notifications
SELECT cron.schedule('pp-send-push', '* * * * *', $$
  SELECT net.http_post(
    url     := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/send-push',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', 'YOUR_CRON_SECRET'),
    body    := '{}'::jsonb)
$$);
