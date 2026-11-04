-- SPDX-License-Identifier: MPL-2.0
--
-- 0595 — what lists and module field defaults reference, indexed, live
-- and pending (issue #1391, epic #1392).
--
-- "Where does content instance X show" (its reach: the parents, pages and
-- layouts an edit of X changes) asks which shared lists list X in their
-- items and which modules list X in a field default. Both were answered by
-- reading every list of the caller's view and every module whose fields
-- contain the text `contentInstanceId`, plus every pending module state of
-- the branch — on every `content_instances.get` and every
-- `content_instances.set_values`, so an agent's write grew with the site's
-- lists and modules (the rows-read test: 26 → 207 rows per call when the
-- fixture grows its lists tenfold).
--
-- Four derived tables in the shape of `content_instance_refs` (0458) and
-- the snapshot reference tables (0592): one row per (row, reference) a
-- list's `items` or a module's `fields` contain, live and in every list /
-- module snapshot state, with the same extraction
-- (`caelo_content_instance_ref_rows`). Statement-level triggers maintain
-- them in the writer's own transaction (rule 3 of
-- docs/dev/state-and-changes.md); `caelo_list_module_refs_rebuild()` is the
-- repair path, run by `content_instances.rebuild_refs`. Readers look the
-- needle up by `(ref_kind, ref)` and confirm every candidate on the parsed
-- items or fields, so a superset is harmless.
--
-- Expand-only: new tables, functions and triggers. The previous image
-- never reads them; its writes fire the triggers.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE list_refs (
  list_id uuid NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  ref_kind text NOT NULL CHECK (ref_kind IN ('id', 'media_slug')),
  ref      text NOT NULL,
  PRIMARY KEY (list_id, ref_kind, ref)
);
CREATE INDEX list_refs_ref_idx ON list_refs (ref_kind, ref);
ALTER TABLE list_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE list_refs FORCE ROW LEVEL SECURITY;
CREATE POLICY list_refs_authenticated_scope ON list_refs
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

/** Trigger: index the inserted rows of lists. */
CREATE FUNCTION caelo_list_refs_on_insert() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  INSERT INTO list_refs (list_id, ref_kind, ref)
  SELECT n.id, r.ref_kind, r.ref
    FROM new_rows n
   CROSS JOIN LATERAL caelo_content_instance_ref_rows(n.items) r
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END
$fn$;

/** Trigger: re-index the rows of lists whose `items` changed (two statements, as in 0458). */
CREATE FUNCTION caelo_list_refs_on_update() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  DELETE FROM list_refs r
   USING new_rows n JOIN old_rows o ON o.id = n.id
   WHERE r.list_id = n.id AND n.items IS DISTINCT FROM o.items;
  INSERT INTO list_refs (list_id, ref_kind, ref)
  SELECT n.id, r.ref_kind, r.ref
    FROM new_rows n
    JOIN old_rows o ON o.id = n.id
   CROSS JOIN LATERAL caelo_content_instance_ref_rows(n.items) r
   WHERE n.items IS DISTINCT FROM o.items
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END
$fn$;

CREATE TRIGGER caelo_list_refs_insert
  AFTER INSERT ON lists
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION caelo_list_refs_on_insert();
CREATE TRIGGER caelo_list_refs_update
  AFTER UPDATE ON lists
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION caelo_list_refs_on_update();

CREATE TABLE module_refs (
  module_id uuid NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  ref_kind text NOT NULL CHECK (ref_kind IN ('id', 'media_slug')),
  ref      text NOT NULL,
  PRIMARY KEY (module_id, ref_kind, ref)
);
CREATE INDEX module_refs_ref_idx ON module_refs (ref_kind, ref);
ALTER TABLE module_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE module_refs FORCE ROW LEVEL SECURITY;
CREATE POLICY module_refs_authenticated_scope ON module_refs
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

/** Trigger: index the inserted rows of modules. */
CREATE FUNCTION caelo_module_refs_on_insert() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  INSERT INTO module_refs (module_id, ref_kind, ref)
  SELECT n.id, r.ref_kind, r.ref
    FROM new_rows n
   CROSS JOIN LATERAL caelo_content_instance_ref_rows(n.fields) r
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END
$fn$;

/** Trigger: re-index the rows of modules whose `fields` changed (two statements, as in 0458). */
CREATE FUNCTION caelo_module_refs_on_update() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  DELETE FROM module_refs r
   USING new_rows n JOIN old_rows o ON o.id = n.id
   WHERE r.module_id = n.id AND n.fields IS DISTINCT FROM o.fields;
  INSERT INTO module_refs (module_id, ref_kind, ref)
  SELECT n.id, r.ref_kind, r.ref
    FROM new_rows n
    JOIN old_rows o ON o.id = n.id
   CROSS JOIN LATERAL caelo_content_instance_ref_rows(n.fields) r
   WHERE n.fields IS DISTINCT FROM o.fields
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END
$fn$;

CREATE TRIGGER caelo_module_refs_insert
  AFTER INSERT ON modules
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION caelo_module_refs_on_insert();
CREATE TRIGGER caelo_module_refs_update
  AFTER UPDATE ON modules
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION caelo_module_refs_on_update();

CREATE TABLE list_snapshot_refs (
  snapshot_row_id uuid NOT NULL REFERENCES list_snapshots(id) ON DELETE CASCADE,
  ref_kind text NOT NULL CHECK (ref_kind IN ('id', 'media_slug')),
  ref      text NOT NULL,
  PRIMARY KEY (snapshot_row_id, ref_kind, ref)
);
CREATE INDEX list_snapshot_refs_ref_idx ON list_snapshot_refs (ref_kind, ref);
ALTER TABLE list_snapshot_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE list_snapshot_refs FORCE ROW LEVEL SECURITY;
CREATE POLICY list_snapshot_refs_authenticated_scope ON list_snapshot_refs
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

/** Trigger: index the inserted rows of list_snapshots. */
CREATE FUNCTION caelo_list_snapshot_refs_on_insert() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  INSERT INTO list_snapshot_refs (snapshot_row_id, ref_kind, ref)
  SELECT n.id, r.ref_kind, r.ref
    FROM new_rows n
   CROSS JOIN LATERAL caelo_content_instance_ref_rows(n.state -> 'items') r
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END
$fn$;

/** Trigger: re-index the rows of list_snapshots whose `state` changed (two statements, as in 0458). */
CREATE FUNCTION caelo_list_snapshot_refs_on_update() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  DELETE FROM list_snapshot_refs r
   USING new_rows n JOIN old_rows o ON o.id = n.id
   WHERE r.snapshot_row_id = n.id AND n.state IS DISTINCT FROM o.state;
  INSERT INTO list_snapshot_refs (snapshot_row_id, ref_kind, ref)
  SELECT n.id, r.ref_kind, r.ref
    FROM new_rows n
    JOIN old_rows o ON o.id = n.id
   CROSS JOIN LATERAL caelo_content_instance_ref_rows(n.state -> 'items') r
   WHERE n.state IS DISTINCT FROM o.state
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END
$fn$;

CREATE TRIGGER caelo_list_snapshot_refs_insert
  AFTER INSERT ON list_snapshots
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION caelo_list_snapshot_refs_on_insert();
CREATE TRIGGER caelo_list_snapshot_refs_update
  AFTER UPDATE ON list_snapshots
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION caelo_list_snapshot_refs_on_update();

CREATE TABLE module_snapshot_refs (
  snapshot_row_id uuid NOT NULL REFERENCES module_snapshots(id) ON DELETE CASCADE,
  ref_kind text NOT NULL CHECK (ref_kind IN ('id', 'media_slug')),
  ref      text NOT NULL,
  PRIMARY KEY (snapshot_row_id, ref_kind, ref)
);
CREATE INDEX module_snapshot_refs_ref_idx ON module_snapshot_refs (ref_kind, ref);
ALTER TABLE module_snapshot_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE module_snapshot_refs FORCE ROW LEVEL SECURITY;
CREATE POLICY module_snapshot_refs_authenticated_scope ON module_snapshot_refs
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

/** Trigger: index the inserted rows of module_snapshots. */
CREATE FUNCTION caelo_module_snapshot_refs_on_insert() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  INSERT INTO module_snapshot_refs (snapshot_row_id, ref_kind, ref)
  SELECT n.id, r.ref_kind, r.ref
    FROM new_rows n
   CROSS JOIN LATERAL caelo_content_instance_ref_rows(n.state -> 'fields') r
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END
$fn$;

/** Trigger: re-index the rows of module_snapshots whose `state` changed (two statements, as in 0458). */
CREATE FUNCTION caelo_module_snapshot_refs_on_update() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  DELETE FROM module_snapshot_refs r
   USING new_rows n JOIN old_rows o ON o.id = n.id
   WHERE r.snapshot_row_id = n.id AND n.state IS DISTINCT FROM o.state;
  INSERT INTO module_snapshot_refs (snapshot_row_id, ref_kind, ref)
  SELECT n.id, r.ref_kind, r.ref
    FROM new_rows n
    JOIN old_rows o ON o.id = n.id
   CROSS JOIN LATERAL caelo_content_instance_ref_rows(n.state -> 'fields') r
   WHERE n.state IS DISTINCT FROM o.state
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END
$fn$;

CREATE TRIGGER caelo_module_snapshot_refs_insert
  AFTER INSERT ON module_snapshots
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION caelo_module_snapshot_refs_on_insert();
CREATE TRIGGER caelo_module_snapshot_refs_update
  AFTER UPDATE ON module_snapshots
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION caelo_module_snapshot_refs_on_update();

/**
 * Rebuild the four tables from their sources (run by the system op
 * `content_instances.rebuild_refs`). Returns how many rows they hold after.
 */
CREATE FUNCTION caelo_list_module_refs_rebuild() RETURNS bigint
LANGUAGE plpgsql
AS $fn$
DECLARE
  n bigint;
BEGIN
  DELETE FROM list_refs;
  INSERT INTO list_refs (list_id, ref_kind, ref)
  SELECT s.id, r.ref_kind, r.ref
    FROM lists s
   CROSS JOIN LATERAL caelo_content_instance_ref_rows(s.items) r
  ON CONFLICT DO NOTHING;
  DELETE FROM module_refs;
  INSERT INTO module_refs (module_id, ref_kind, ref)
  SELECT s.id, r.ref_kind, r.ref
    FROM modules s
   CROSS JOIN LATERAL caelo_content_instance_ref_rows(s.fields) r
  ON CONFLICT DO NOTHING;
  DELETE FROM list_snapshot_refs;
  INSERT INTO list_snapshot_refs (snapshot_row_id, ref_kind, ref)
  SELECT s.id, r.ref_kind, r.ref
    FROM list_snapshots s
   CROSS JOIN LATERAL caelo_content_instance_ref_rows(s.state -> 'items') r
  ON CONFLICT DO NOTHING;
  DELETE FROM module_snapshot_refs;
  INSERT INTO module_snapshot_refs (snapshot_row_id, ref_kind, ref)
  SELECT s.id, r.ref_kind, r.ref
    FROM module_snapshots s
   CROSS JOIN LATERAL caelo_content_instance_ref_rows(s.state -> 'fields') r
  ON CONFLICT DO NOTHING;
  SELECT (SELECT count(*) FROM list_refs) + (SELECT count(*) FROM module_refs)
       + (SELECT count(*) FROM list_snapshot_refs) + (SELECT count(*) FROM module_snapshot_refs) INTO n;
  RETURN n;
END
$fn$;

-- Backfill: every row written before this migration.
SELECT caelo_list_module_refs_rebuild();

ANALYZE list_refs;
ANALYZE module_refs;
ANALYZE list_snapshot_refs;
ANALYZE module_snapshot_refs;

COMMIT;
