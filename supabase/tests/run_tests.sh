#!/usr/bin/env bash
# Each test file gets its own throwaway database that mimics Supabase, with every migration applied.
set -e
PSQL="psql -h ${PGHOST:-/tmp} -p ${PGPORT:-5433} -U ${PGUSER:-postgres}"
DIR="$(cd "$(dirname "$0")" && pwd)"
for TEST in backend_tests.sql v21_tests.sql v22_tests.sql; do
  DB=pp_test_$$_${TEST%%.*}
  $PSQL -q -c "CREATE DATABASE $DB" >/dev/null
  $PSQL -q -d $DB -f "$DIR/supabase_stub.sql" 2>/dev/null
  $PSQL -q -d $DB -v ON_ERROR_STOP=1 -f "$DIR/../migrations/01_schema_v2.sql"
  $PSQL -q -d $DB -v ON_ERROR_STOP=1 -f "$DIR/../migrations/03_v2_1_features.sql"
  $PSQL -q -d $DB -v ON_ERROR_STOP=1 -f "$DIR/../migrations/04_dms.sql"
  $PSQL -q -d $DB -f "$DIR/$TEST" 2>&1 | sed -e 's/^psql:[^ ]* NOTICE:  //' -e 's/^NOTICE:  //' | grep -E '^(PASS|FAIL|==)|ERROR' || true
  $PSQL -q -c "DROP DATABASE $DB" >/dev/null
done
