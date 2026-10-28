-- SPDX-License-Identifier: MPL-2.0
--
-- 0392 — a stuck statement or transaction fails in seconds (#1210).
--
-- Nothing bounded how long a session may wait or sit idle inside a
-- transaction. On 2026-10-28 the production admin held every pooled
-- connection `idle in transaction` for minutes while the database idled;
-- the adapter now refuses the nested checkout that caused it and bounds
-- the wait for a connection (query-api pool-guard.ts), and these limits are
-- the database's own backstop for whatever still gets stuck — a hung
-- request, a leaked connection, a lock queue behind a long writer:
--
--   statement_timeout = 60s
--       The slowest statement the admin runs today (the Stage's full-site
--       reads and merge, 0.5–2 s at ~120 pages; #1003 measures far below a
--       minute for larger sites) has a 30× margin. A statement past a
--       minute is stuck, not slow.
--   lock_timeout = 15s
--       Row and advisory locks are held for one short transaction. A wait
--       past 15 s means the holder is stuck; the waiter fails with a
--       Postgres error instead of queueing behind it (the redirect sync and
--       the staging keep-alive retry on their next run).
--   idle_in_transaction_session_timeout = 60s
--       A transaction idle for a minute holds a pool connection and its
--       locks while nothing happens. Postgres ends the session, the
--       transaction rolls back, the connection returns to the pool.
--
-- Long paths that still keep their transaction open across a build or an
-- upload — Stage / Publish live (#1211) and the plugin-data build — lift the
-- three limits for their own transaction only (`SET LOCAL`, the allowlist in
-- packages/query-api/src/pool-guard.ts) until #1211 removes that
-- transaction. The migration runner lifts them for each migration
-- (runner.ts); pg_dump lifts them itself.
--
-- Set on the two databases rather than on the roles: every login of them
-- (admin_role, public_role, the operator-access and updater roles) gets the
-- same limits, and the database owner (admin_role) may set them where it
-- has no CREATEROLE to alter other roles. New sessions pick them up; the
-- pools' connections are recycled within POOL_IDLE_TIMEOUT_SECONDS.
--
-- Rollback to the previous image: its Stage does not lift the limits, so a
-- Stage whose build + upload keeps the transaction idle for over a minute
-- fails loudly (the run is marked failed; nothing is half-published). To
-- run such a Stage on the previous image, reset the limits:
--   ALTER DATABASE cms_admin RESET idle_in_transaction_session_timeout;

BEGIN;

DO $$
DECLARE
  db text;
BEGIN
  FOREACH db IN ARRAY ARRAY[current_database(), 'cms_public'] LOOP
    IF EXISTS (SELECT 1 FROM pg_database WHERE datname = db) THEN
      EXECUTE format('ALTER DATABASE %I SET statement_timeout = %L', db, '60s');
      EXECUTE format('ALTER DATABASE %I SET lock_timeout = %L', db, '15s');
      EXECUTE format('ALTER DATABASE %I SET idle_in_transaction_session_timeout = %L', db, '60s');
    END IF;
  END LOOP;
END
$$;

COMMIT;
