#!/usr/bin/env bash
#
# Proves the CI PostgreSQL service is reachable and behaves like a real
# server: two sessions overlap, and the second one's `SELECT ... FOR UPDATE`
# waits on the row lock the first is holding. PGlite cannot do this, which is
# the whole reason the service exists (see .github/workflows/ci.yml).
#
# It fails the job when the service is missing or does not block, so a
# regression that needs a real database can never pass by quietly skipping.
set -euo pipefail

: "${DIGITAL_SHELF_TEST_POSTGRES_URL:?DIGITAL_SHELF_TEST_POSTGRES_URL is not set}"

psql() { command psql "$DIGITAL_SHELF_TEST_POSTGRES_URL" -v ON_ERROR_STOP=1 -X -q -A -t "$@"; }

echo "Connecting to the disposable Postgres..."
psql -c 'select version()'

psql <<'SQL'
drop table if exists ci_lock_probe;
create table ci_lock_probe (id int primary key, n int not null);
insert into ci_lock_probe values (1, 0);
SQL

# Session A takes the row lock and holds it well past session B's timeout.
psql >/dev/null <<'SQL' &
begin;
select n from ci_lock_probe where id = 1 for update;
select pg_sleep(10);
commit;
SQL
holder=$!
trap 'kill "${holder}" 2>/dev/null || true' EXIT

# Wait until session A's lock is actually granted; SELECT ... FOR UPDATE
# takes a RowShareLock on the table.
held=""
for _ in $(seq 1 50); do
  held=$(psql -c "select count(*) from pg_locks l
                  join pg_class c on c.oid = l.relation
                  where c.relname = 'ci_lock_probe'
                    and l.mode = 'RowShareLock'
                    and l.granted")
  [ "${held}" -ge 1 ] && break
  sleep 0.2
done
if [ "${held:-0}" -lt 1 ]; then
  echo "::error::session A never took the row lock"
  exit 1
fi

# Session B must block on the same row and hit its own lock timeout. Anything
# else means the two sessions are not really overlapping.
echo "Session A holds the row; checking that session B waits..."
set +e
blocked=$(psql <<'SQL' 2>&1
set lock_timeout = '3s';
begin;
select n from ci_lock_probe where id = 1 for update;
commit;
SQL
)
status=$?
set -e

if [ "${status}" -eq 0 ]; then
  echo "::error::session B did not wait on the lock session A was holding"
  exit 1
fi
if ! grep -qi 'lock timeout' <<<"${blocked}"; then
  echo "::error::session B failed for the wrong reason: ${blocked}"
  exit 1
fi
echo "Session B waited and timed out on the lock, as it should."

wait "${holder}"
trap - EXIT
psql -c 'drop table ci_lock_probe'
echo "Disposable Postgres proven: overlapping transactions, real row locks."
