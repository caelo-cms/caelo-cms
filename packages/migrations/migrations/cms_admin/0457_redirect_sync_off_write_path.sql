-- SPDX-License-Identifier: MPL-2.0
--
-- 0457 — the redirect sync leaves the write path (issue #1254).
--
-- Until now every redirects write — and every page URL move, even one that
-- created no redirect — upserted `redirect_sync_state` (one row per deploy
-- target, i.e. a site-wide row) inside the writer's transaction, and the
-- sync after the commit held those rows `FOR UPDATE` and the live-release
-- lease row in its own transaction across the provider's network calls. Two
-- page writes therefore serialised on the state rows, and a page write
-- waited for a whole provider push (production, 2026-10-29: every
-- `create_variant` of five parallel agents queued behind it).
--
-- 1. `redirect_changes` — an insert-only log, one row per transaction that
--    actually changed a `redirects` row (written by row triggers, so a
--    statement that matched nothing, or an UPDATE that changed no value,
--    leaves no row). Keyed by the writer's own transaction id: two writers
--    never insert the same key and never wait on each other. The sync folds
--    the rows it can see into `redirect_sync_state.wanted_revision` (and
--    deletes them) in a short transaction of its own; a row of a
--    transaction still running is not visible, stays, and is folded by the
--    next sync. Nothing on the write path touches `redirect_sync_state`
--    any more.
--
-- 2. `deploy_leases.holder_sync_id` — the sync no longer holds a lease ROW
--    LOCK across the provider calls. It CLAIMS the lease (like a Publish
--    live does), commits, pushes with no transaction open and releases the
--    lease afterwards. A sync is not a deploy run, so it holds the lease by
--    its own id; at most one of the two holder columns is set.
--
-- Expand-only: a new table + triggers and a nullable column. During a
-- rolling update the previous release still bumps `redirect_sync_state` in
-- its writes (harmless: the state stays exact) and reads the lease as free
-- while a sync of this release holds it; the CHECK makes its claim fail
-- loudly instead of letting two releases write the live channel at once.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE IF NOT EXISTS redirect_changes (
  xid xid8 PRIMARY KEY
);

ALTER TABLE redirect_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE redirect_changes FORCE ROW LEVEL SECURITY;
-- Transaction ids only, no site data. Every actor that may write redirects
-- (human, ai, plugin, system) must be able to record its change, and the
-- sync (system) folds the log.
DROP POLICY IF EXISTS redirect_changes_all ON redirect_changes;
CREATE POLICY redirect_changes_all ON redirect_changes
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

/**
 * Trigger: the current transaction changed a redirect. The primary key
 * collapses repeats inside one transaction.
 */
CREATE OR REPLACE FUNCTION caelo_mark_redirect_change() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  INSERT INTO redirect_changes (xid) VALUES (pg_current_xact_id()) ON CONFLICT DO NOTHING;
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS caelo_redirect_change_ins_del ON redirects;
CREATE TRIGGER caelo_redirect_change_ins_del
  AFTER INSERT OR DELETE ON redirects FOR EACH ROW
  EXECUTE FUNCTION caelo_mark_redirect_change();

DROP TRIGGER IF EXISTS caelo_redirect_change_upd ON redirects;
CREATE TRIGGER caelo_redirect_change_upd
  AFTER UPDATE ON redirects FOR EACH ROW
  WHEN (OLD.from_path IS DISTINCT FROM NEW.from_path
        OR OLD.to_path IS DISTINCT FROM NEW.to_path
        OR OLD.status_code IS DISTINCT FROM NEW.status_code)
  EXECUTE FUNCTION caelo_mark_redirect_change();

-- A TRUNCATE has no rows to fire on.
DROP TRIGGER IF EXISTS caelo_redirect_change_truncate ON redirects;
CREATE TRIGGER caelo_redirect_change_truncate
  AFTER TRUNCATE ON redirects FOR EACH STATEMENT
  EXECUTE FUNCTION caelo_mark_redirect_change();

ALTER TABLE deploy_leases ADD COLUMN IF NOT EXISTS holder_sync_id uuid NULL;
ALTER TABLE deploy_leases DROP CONSTRAINT IF EXISTS deploy_leases_one_holder;
ALTER TABLE deploy_leases
  ADD CONSTRAINT deploy_leases_one_holder
  CHECK (holder_run_id IS NULL OR holder_sync_id IS NULL);

COMMIT;
