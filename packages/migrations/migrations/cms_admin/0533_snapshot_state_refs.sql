-- SPDX-License-Identifier: MPL-2.0
--
-- 0533 — what a pending snapshot state references, indexed (issue #1391,
-- epic #1392).
--
-- "Which content instances / pages show X" is answered for live rows by
-- `content_instance_refs` (0458) and `page_modules`. A chat's branch view
-- also has PENDING states — the newest content-instance and page-layout
-- snapshot of each entity the draft changed (the draft head, 0477) — and
-- those were filtered in memory or by `strpos` over every pending state,
-- once per needle. On the shared draft between two Stages that is every
-- entity any chat changed: on searchVIU production (2026-11-03, 900
-- pending instances) one consent-manager read of a module's instances ran
-- 270 needles against 900 states after every agent write and saturated
-- the db-f1-micro; at 2,000 pages one such statement ran over 50 s.
--
-- Two derived tables, the shape of `content_instance_refs`: one row per
-- (snapshot row, kind, reference) its state contains, with the extraction
-- of 0458 (`caelo_content_instance_ref_rows`: every UUID lower-cased, and
-- every `/_caelo/media/<slug>`), maintained by statement-level triggers in
-- the writer's own transaction (rule 3 of docs/dev/state-and-changes.md).
-- A reader looks a needle up by `(ref_kind, ref)` and keeps the snapshot
-- rows that are a head row of its branch (`draft_pending_entities_row_idx`),
-- so the cost is the matches, never the draft; readers still confirm every
-- candidate on the parsed state. Tables, not a GIN expression index: the
-- snapshot tables force row-level security, and Postgres uses an index
-- under RLS only for leakproof operators — array overlap is not one, a
-- text `=` is.
--
-- Snapshot rows are inserted once; the link migration may rewrite a
-- pending state in place, so an UPDATE of `state` re-indexes the row. A
-- deleted snapshot row takes its references with it (ON DELETE CASCADE).
-- The module of a pending instance state gets a plain expression index for
-- "the instances of these modules".
--
-- Expand-only: new tables, functions, triggers and an index. The previous
-- image never reads them; its snapshot writes fire the triggers.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE content_instance_snapshot_refs (
  snapshot_row_id uuid NOT NULL REFERENCES content_instance_snapshots(id) ON DELETE CASCADE,
  ref_kind        text NOT NULL CHECK (ref_kind IN ('id', 'media_slug')),
  ref             text NOT NULL,
  PRIMARY KEY (snapshot_row_id, ref_kind, ref)
);
CREATE INDEX content_instance_snapshot_refs_ref_idx
  ON content_instance_snapshot_refs (ref_kind, ref);

CREATE TABLE page_layout_snapshot_refs (
  snapshot_row_id uuid NOT NULL REFERENCES page_layout_snapshots(id) ON DELETE CASCADE,
  ref_kind        text NOT NULL CHECK (ref_kind IN ('id', 'media_slug')),
  ref             text NOT NULL,
  PRIMARY KEY (snapshot_row_id, ref_kind, ref)
);
CREATE INDEX page_layout_snapshot_refs_ref_idx
  ON page_layout_snapshot_refs (ref_kind, ref);

-- Same scope as the snapshot tables: every actor that writes a snapshot
-- maintains its references, and every reader of snapshots may read them.
ALTER TABLE content_instance_snapshot_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_instance_snapshot_refs FORCE ROW LEVEL SECURITY;
CREATE POLICY content_instance_snapshot_refs_authenticated_scope ON content_instance_snapshot_refs
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);
ALTER TABLE page_layout_snapshot_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE page_layout_snapshot_refs FORCE ROW LEVEL SECURITY;
CREATE POLICY page_layout_snapshot_refs_authenticated_scope ON page_layout_snapshot_refs
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

-- A pending content-instance state: the module it fills.
CREATE INDEX content_instance_snapshots_module_idx
  ON content_instance_snapshots ((state ->> 'moduleId'));

/** Trigger: index the values of inserted content-instance snapshots. */
CREATE FUNCTION caelo_content_instance_snapshot_refs_on_insert() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  INSERT INTO content_instance_snapshot_refs (snapshot_row_id, ref_kind, ref)
  SELECT n.id, r.ref_kind, r.ref
    FROM new_rows n
   CROSS JOIN LATERAL caelo_content_instance_ref_rows(n.state -> 'values') r
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END
$fn$;

/**
 * Trigger: re-index content-instance snapshots whose state changed (the
 * link migration rewrites pending states). Two statements, as in 0458.
 */
CREATE FUNCTION caelo_content_instance_snapshot_refs_on_update() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  DELETE FROM content_instance_snapshot_refs r
   USING new_rows n JOIN old_rows o ON o.id = n.id
   WHERE r.snapshot_row_id = n.id AND n.state IS DISTINCT FROM o.state;
  INSERT INTO content_instance_snapshot_refs (snapshot_row_id, ref_kind, ref)
  SELECT n.id, r.ref_kind, r.ref
    FROM new_rows n
    JOIN old_rows o ON o.id = n.id
   CROSS JOIN LATERAL caelo_content_instance_ref_rows(n.state -> 'values') r
   WHERE n.state IS DISTINCT FROM o.state
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END
$fn$;

/** Trigger: index the placements of inserted page-layout snapshots. */
CREATE FUNCTION caelo_page_layout_snapshot_refs_on_insert() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  INSERT INTO page_layout_snapshot_refs (snapshot_row_id, ref_kind, ref)
  SELECT n.id, r.ref_kind, r.ref
    FROM new_rows n
   CROSS JOIN LATERAL caelo_content_instance_ref_rows(n.state) r
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END
$fn$;

/** Trigger: re-index page-layout snapshots whose state changed. */
CREATE FUNCTION caelo_page_layout_snapshot_refs_on_update() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  DELETE FROM page_layout_snapshot_refs r
   USING new_rows n JOIN old_rows o ON o.id = n.id
   WHERE r.snapshot_row_id = n.id AND n.state IS DISTINCT FROM o.state;
  INSERT INTO page_layout_snapshot_refs (snapshot_row_id, ref_kind, ref)
  SELECT n.id, r.ref_kind, r.ref
    FROM new_rows n
    JOIN old_rows o ON o.id = n.id
   CROSS JOIN LATERAL caelo_content_instance_ref_rows(n.state) r
   WHERE n.state IS DISTINCT FROM o.state
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END
$fn$;

CREATE TRIGGER caelo_content_instance_snapshot_refs_insert
  AFTER INSERT ON content_instance_snapshots
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION caelo_content_instance_snapshot_refs_on_insert();
CREATE TRIGGER caelo_content_instance_snapshot_refs_update
  AFTER UPDATE ON content_instance_snapshots
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION caelo_content_instance_snapshot_refs_on_update();
CREATE TRIGGER caelo_page_layout_snapshot_refs_insert
  AFTER INSERT ON page_layout_snapshots
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION caelo_page_layout_snapshot_refs_on_insert();
CREATE TRIGGER caelo_page_layout_snapshot_refs_update
  AFTER UPDATE ON page_layout_snapshots
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION caelo_page_layout_snapshot_refs_on_update();

/**
 * Rebuild both tables from the snapshot rows (run by the system op
 * `content_instances.rebuild_refs` next to 0458's rebuild). Returns how
 * many rows they hold after.
 */
CREATE FUNCTION caelo_snapshot_refs_rebuild() RETURNS bigint
LANGUAGE plpgsql
AS $fn$
DECLARE
  n bigint;
BEGIN
  DELETE FROM content_instance_snapshot_refs;
  INSERT INTO content_instance_snapshot_refs (snapshot_row_id, ref_kind, ref)
  SELECT s.id, r.ref_kind, r.ref
    FROM content_instance_snapshots s
   CROSS JOIN LATERAL caelo_content_instance_ref_rows(s.state -> 'values') r
  ON CONFLICT DO NOTHING;
  DELETE FROM page_layout_snapshot_refs;
  INSERT INTO page_layout_snapshot_refs (snapshot_row_id, ref_kind, ref)
  SELECT s.id, r.ref_kind, r.ref
    FROM page_layout_snapshots s
   CROSS JOIN LATERAL caelo_content_instance_ref_rows(s.state) r
  ON CONFLICT DO NOTHING;
  SELECT (SELECT count(*) FROM content_instance_snapshot_refs)
       + (SELECT count(*) FROM page_layout_snapshot_refs) INTO n;
  RETURN n;
END
$fn$;

-- Backfill: every snapshot row written before this migration.
SELECT caelo_snapshot_refs_rebuild();

ANALYZE content_instance_snapshot_refs;
ANALYZE page_layout_snapshot_refs;

COMMIT;
