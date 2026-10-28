-- SPDX-License-Identifier: MPL-2.0
--
-- 0395 — change log that lets the font usage scan be cached (issue #803,
-- epic #1209).
--
-- `loadSiteFontUsage` (static-generator) reads every module, template,
-- layout, content instance, placement content row and plugin source to
-- derive the font weights a pinned variable face must carry. Preview and
-- build both call it; on a large site that is a whole-site dump per
-- render. The admin now caches the scan result in-process and needs an
-- O(recent changes) way to prove that none of those six tables changed
-- between the snapshot the cached scan read and the reader's snapshot.
--
-- Why not a counter row: a trigger that UPDATEs one generation row holds
-- that row's lock until the writing transaction commits, so every two
-- transactions writing content would serialise on it — exactly the stall
-- class epic #1209 removes. Why not max(bigserial): ids are handed out in
-- start order, not commit order, so a reader could cache max = 11 while
-- transaction 10 is still running and miss it when 10 commits.
--
-- Instead every writing transaction leaves one insert-only row carrying its
-- own transaction id (`kind = 'change'`). Different transactions insert
-- different keys, so writers never wait on each other. A cached scan
-- records the snapshot it read (`pg_current_snapshot()`); a reader proves
-- the cache current when its own snapshot has seen every transaction the
-- cached one saw and no change row it can see is invisible to the cached
-- snapshot (`pg_visible_in_snapshot`). Only rows with xid >= the cached
-- snapshot's xmin can differ, so the check is an index range scan over the
-- recent tail. A rolled-back write leaves no row, which is correct: its
-- changes never became visible either.
--
-- Garbage collection (opportunistic, on a cache miss in a writable
-- transaction): rows below the GC transaction's snapshot xmin are deleted
-- (`FOR UPDATE SKIP LOCKED`, never waits) and a `kind = 'horizon'` row
-- records that xmin. A cached snapshot whose xmin is below any horizon is
-- treated as stale, because a change row it would need may be gone.
--
-- Expand-only: new table, function and triggers. The previous release's
-- writes fire the triggers too and are simply recorded.

SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE IF NOT EXISTS font_usage_changes (
  kind text NOT NULL CHECK (kind IN ('change', 'horizon')),
  xid  xid8 NOT NULL,
  PRIMARY KEY (kind, xid)
);

ALTER TABLE font_usage_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE font_usage_changes FORCE ROW LEVEL SECURITY;
-- The table holds transaction ids only, no site data. Every write path to
-- the six content tables (any actor kind: human, ai, system, plugin ops)
-- must be able to record its change, and every preview/build reader must
-- be able to read and garbage-collect the log, whatever actor it acts for.
DROP POLICY IF EXISTS font_usage_changes_all ON font_usage_changes;
CREATE POLICY font_usage_changes_all ON font_usage_changes
  USING (true) WITH CHECK (true);

/**
 * Trigger: record that the current transaction changed a table the font
 * usage scan reads. Statement level, once per statement; the primary key
 * collapses repeats inside one transaction.
 */
CREATE OR REPLACE FUNCTION caelo_mark_font_usage_change() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  INSERT INTO font_usage_changes (kind, xid) VALUES ('change', pg_current_xact_id())
    ON CONFLICT DO NOTHING;
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS caelo_font_usage_change ON modules;
CREATE TRIGGER caelo_font_usage_change
  AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON modules FOR EACH STATEMENT
  EXECUTE FUNCTION caelo_mark_font_usage_change();

DROP TRIGGER IF EXISTS caelo_font_usage_change ON templates;
CREATE TRIGGER caelo_font_usage_change
  AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON templates FOR EACH STATEMENT
  EXECUTE FUNCTION caelo_mark_font_usage_change();

DROP TRIGGER IF EXISTS caelo_font_usage_change ON layouts;
CREATE TRIGGER caelo_font_usage_change
  AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON layouts FOR EACH STATEMENT
  EXECUTE FUNCTION caelo_mark_font_usage_change();

DROP TRIGGER IF EXISTS caelo_font_usage_change ON content_instances;
CREATE TRIGGER caelo_font_usage_change
  AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON content_instances FOR EACH STATEMENT
  EXECUTE FUNCTION caelo_mark_font_usage_change();

DROP TRIGGER IF EXISTS caelo_font_usage_change ON page_module_content;
CREATE TRIGGER caelo_font_usage_change
  AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON page_module_content FOR EACH STATEMENT
  EXECUTE FUNCTION caelo_mark_font_usage_change();

-- plugins rows change for many reasons (status, health, cost caps); only
-- the two columns the scan reads invalidate it.
DROP TRIGGER IF EXISTS caelo_font_usage_change ON plugins;
CREATE TRIGGER caelo_font_usage_change
  AFTER INSERT OR UPDATE OF slug, source_code OR DELETE OR TRUNCATE ON plugins FOR EACH STATEMENT
  EXECUTE FUNCTION caelo_mark_font_usage_change();
