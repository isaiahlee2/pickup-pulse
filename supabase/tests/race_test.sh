#!/usr/bin/env bash
# 20 players tap "I'm In" on a game with 1 open spot at the same moment.
DB=pp_race_$$; PSQL="psql -h ${PGHOST:-/tmp} -p ${PGPORT:-5433} -U ${PGUSER:-postgres} -q"
DIR="$(cd "$(dirname "$0")" && pwd)"
$PSQL -c "CREATE DATABASE $DB" >/dev/null
$PSQL -d $DB -f "$DIR/supabase_stub.sql" 2>/dev/null
$PSQL -d $DB -v ON_ERROR_STOP=1 -f "$DIR/../migrations/01_schema_v2.sql" >/dev/null
$PSQL -d $DB -v ON_ERROR_STOP=1 -f "$DIR/../migrations/03_v2_1_features.sql" >/dev/null
$PSQL -d $DB >/dev/null <<'SQL'
INSERT INTO auth.users (id, email, raw_user_meta_data) SELECT gen_random_uuid(), 'p' || i || '@osu.edu', '{"adult_confirmed": true}' FROM generate_series(0, 20) i;
INSERT INTO public.games (creator_id, sport, location_name, location_lat, location_lng, note, spots_needed, game_start_time)
SELECT id, 'Basketball', 'Dixon', 44.5633, -123.2794, 'need 1', 1, now() FROM public.users ORDER BY username LIMIT 1;
SQL
GAME=$($PSQL -d $DB -tAc "SELECT id FROM public.games")
for U in $($PSQL -d $DB -tAc "SELECT id FROM public.users WHERE id NOT IN (SELECT creator_id FROM public.games)"); do
  $PSQL -d $DB -tAc "SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','$U',false); SELECT public.rsvp_join('$GAME')->>'status';" 2>&1 | tail -1 &
done | sort | uniq -c
wait
$PSQL -d $DB -tAc "SELECT 'final: spots_open=' || spots_open || ', current_rsvps=' || current_rsvps FROM public.games"
$PSQL -c "DROP DATABASE $DB" >/dev/null
