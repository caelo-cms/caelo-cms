-- SPDX-License-Identifier: MPL-2.0
--
-- 0594 — the terms of a pending page state, indexed (issue #1269, epic
-- #1392).
--
-- "Which pages carry a term of list L" is answered for live rows by
-- `page_terms`. A chat's branch view also has the PENDING page states (the
-- draft head, 0477), and `pageTermsOfList` read every one of them to find
-- the few that carry L — on the shared draft between two Stages that is
-- every page any chat edited, so one `lists.get` read grew with the draft
-- (the rows-read test: 999 pending page states per call on its small
-- fixture, 10,000 on the large one).
--
-- A third table in the shape of 0592's snapshot reference tables: one row
-- per (page snapshot row, reference) its `terms` contain, with the same
-- extraction (`caelo_content_instance_ref_rows`: every UUID lower-cased,
-- so a term `caelo:term/<list>/<item>` indexes both ids), maintained by
-- statement-level triggers in the writer's own transaction (rule 3 of
-- docs/dev/state-and-changes.md). Readers look the list id up and keep the
-- rows that are a head row of their branch, then confirm on the parsed
-- state. Only `terms`: nothing else reads a page state by reference yet,
-- and a page's whole state would index its every field.
--
-- `caelo_snapshot_refs_rebuild()` is replaced to rebuild this table too.
--
-- Also: the pending top-level pages of a branch by slug, for the root
-- lookup of `site_defaults.get` (a chat that renames a page to `home`
-- moves the branch's root): without it the lookup would read every
-- pending top-level page of the draft.
--
-- Expand-only: a new table, functions and triggers. The previous image
-- never reads the table; its page snapshot writes fire the triggers.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE page_snapshot_refs (
  snapshot_row_id uuid NOT NULL REFERENCES page_snapshots(id) ON DELETE CASCADE,
  ref_kind        text NOT NULL CHECK (ref_kind IN ('id', 'media_slug')),
  ref             text NOT NULL,
  PRIMARY KEY (snapshot_row_id, ref_kind, ref)
);
CREATE INDEX page_snapshot_refs_ref_idx ON page_snapshot_refs (ref_kind, ref);

-- Same scope as the snapshot tables (0592).
ALTER TABLE page_snapshot_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE page_snapshot_refs FORCE ROW LEVEL SECURITY;
CREATE POLICY page_snapshot_refs_authenticated_scope ON page_snapshot_refs
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

/** Trigger: index the terms of inserted page snapshots. */
CREATE FUNCTION caelo_page_snapshot_refs_on_insert() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  INSERT INTO page_snapshot_refs (snapshot_row_id, ref_kind, ref)
  SELECT n.id, r.ref_kind, r.ref
    FROM new_rows n
   CROSS JOIN LATERAL caelo_content_instance_ref_rows(n.state -> 'terms') r
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END
$fn$;

/** Trigger: re-index page snapshots whose state changed (the link migration). */
CREATE FUNCTION caelo_page_snapshot_refs_on_update() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  DELETE FROM page_snapshot_refs r
   USING new_rows n JOIN old_rows o ON o.id = n.id
   WHERE r.snapshot_row_id = n.id AND n.state IS DISTINCT FROM o.state;
  INSERT INTO page_snapshot_refs (snapshot_row_id, ref_kind, ref)
  SELECT n.id, r.ref_kind, r.ref
    FROM new_rows n
    JOIN old_rows o ON o.id = n.id
   CROSS JOIN LATERAL caelo_content_instance_ref_rows(n.state -> 'terms') r
   WHERE n.state IS DISTINCT FROM o.state
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END
$fn$;

CREATE TRIGGER caelo_page_snapshot_refs_insert
  AFTER INSERT ON page_snapshots
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION caelo_page_snapshot_refs_on_insert();
CREATE TRIGGER caelo_page_snapshot_refs_update
  AFTER UPDATE ON page_snapshots
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION caelo_page_snapshot_refs_on_update();

/**
 * Rebuild the three snapshot reference tables from the snapshot rows (run
 * by the system op `content_instances.rebuild_refs`). Returns how many rows
 * they hold after.
 */
CREATE OR REPLACE FUNCTION caelo_snapshot_refs_rebuild() RETURNS bigint
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
  DELETE FROM page_snapshot_refs;
  INSERT INTO page_snapshot_refs (snapshot_row_id, ref_kind, ref)
  SELECT s.id, r.ref_kind, r.ref
    FROM page_snapshots s
   CROSS JOIN LATERAL caelo_content_instance_ref_rows(s.state -> 'terms') r
  ON CONFLICT DO NOTHING;
  SELECT (SELECT count(*) FROM content_instance_snapshot_refs)
       + (SELECT count(*) FROM page_layout_snapshot_refs)
       + (SELECT count(*) FROM page_snapshot_refs) INTO n;
  RETURN n;
END
$fn$;

-- Backfill: the terms of every page snapshot written before this migration.
INSERT INTO page_snapshot_refs (snapshot_row_id, ref_kind, ref)
SELECT s.id, r.ref_kind, r.ref
  FROM page_snapshots s
 CROSS JOIN LATERAL caelo_content_instance_ref_rows(s.state -> 'terms') r
ON CONFLICT DO NOTHING;

CREATE INDEX draft_pending_entities_top_level_slug_idx ON draft_pending_entities
  (chat_branch_id, slug) WHERE entity_kind = 'page' AND parent_page_id IS NULL;

ANALYZE page_snapshot_refs;

COMMIT;
