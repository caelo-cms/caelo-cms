-- SPDX-License-Identifier: MPL-2.0
--
-- 0458 — what content-instance values reference, indexed (issue #1287).
--
-- A content instance's `values` point at other entities without any
-- relational row: a `module` / `module-list` field stores
-- `{ moduleId, contentInstanceId }`, a list binding `caelo:list/<id>`, an
-- image `/_caelo/media/<slug>` or `caelo:media/<id>`. Until now every
-- "who references X" question (the nested-content tree of
-- `page_module_content.list_for_page`, an instance's reach, a module's
-- placements, a list's usage, the media delete guard) answered it with
-- `values::text LIKE '%<needle>%' OR …` over every live content instance:
-- no index can serve that, so the cost was all content on the site times
-- the needles. On searchVIU (2026-11-01) it passed the 60 s statement
-- timeout, which aborted international-site's activation and every Stage.
--
-- `content_instance_refs` is synchronous derived state (rule 3 of
-- docs/dev/state-and-changes.md): one row per (instance, kind, reference)
-- its values contain, maintained by statement-level triggers on
-- `content_instances` in the writer's own transaction, so a read in that
-- transaction is already exact. One extraction function serves the
-- triggers, the backfill below, the rebuild (`content_instances.
-- rebuild_refs`) and the consistency check (scripts/test-preload.ts).
--
-- The kinds are deliberately coarse — a SUPERSET of what any reader needs;
-- every reader confirms its candidates against the parsed values:
--   id          every UUID anywhere in the values text, lower-cased
--               (nested instance and module ids, list ids, media ids of
--               `caelo:media/<id>` and the legacy `/_caelo/media/<id>/…`)
--   media_slug  the slug of every `/_caelo/media/<slug>` URL, with the
--               exact pattern `extractMediaRefs` uses (packages/shared
--               media.ts), so a slug matches whole, never as a prefix
--
-- The reach walk used to switch to "every instance with any nested ref"
-- past 20 ids, because each id cost one more LIKE over the whole table;
-- with the index an id lookup costs the same for one id or a hundred, so
-- there is no such kind.
--
-- A deleted instance's rows go with it (ON DELETE CASCADE); a soft delete
-- keeps them and the readers filter `deleted_at`. Branch-created instances
-- are rows of the same table and are indexed like any other; the pending
-- snapshot states of a branch stay in memory in the readers (bounded by
-- the branch).
--
-- Expand-only: a new table, function and triggers. During a rolling update
-- the previous image never reads the table; its writes fire the triggers
-- like this release's writes do.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE content_instance_refs (
  content_instance_id uuid NOT NULL REFERENCES content_instances(id) ON DELETE CASCADE,
  ref_kind            text NOT NULL CHECK (ref_kind IN ('id', 'media_slug')),
  ref                 text NOT NULL,
  PRIMARY KEY (content_instance_id, ref_kind, ref)
);

-- The readers' lookup: which instances reference this id / slug.
CREATE INDEX content_instance_refs_ref_idx ON content_instance_refs (ref_kind, ref);

ALTER TABLE content_instance_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_instance_refs FORCE ROW LEVEL SECURITY;
-- Same scope as content_instances itself: every actor that may write an
-- instance must be able to maintain its references, and every reader of
-- instances may read them.
CREATE POLICY content_instance_refs_authenticated_scope ON content_instance_refs
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

/**
 * The references one `values` document contains — the single definition
 * of the derived rows (triggers, backfill, rebuild, consistency check).
 */
CREATE FUNCTION caelo_content_instance_ref_rows(v jsonb)
RETURNS TABLE (ref_kind text, ref text)
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $fn$
  SELECT 'id'::text, lower(m[1])
    FROM regexp_matches(v::text,
      '([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})', 'g') AS m
  UNION
  SELECT 'media_slug'::text, m[1]
    FROM regexp_matches(v::text, '/_caelo/media/([a-z0-9][a-z0-9-]{0,63})', 'g') AS m
$fn$;

/** Trigger: index the values of the inserted instances. */
CREATE FUNCTION caelo_content_instance_refs_on_insert() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  INSERT INTO content_instance_refs (content_instance_id, ref_kind, ref)
  SELECT n.id, r.ref_kind, r.ref
    FROM new_rows n
   CROSS JOIN LATERAL caelo_content_instance_ref_rows(n."values") r
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END
$fn$;

/**
 * Trigger: re-index the instances whose values changed. An UPDATE that
 * leaves `values` as it was (a slug, a soft delete, a version bump)
 * touches nothing. Two statements, not one: an INSERT … ON CONFLICT in the
 * same statement as the DELETE would still see the rows it replaces.
 */
CREATE FUNCTION caelo_content_instance_refs_on_update() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  DELETE FROM content_instance_refs r
   USING new_rows n JOIN old_rows o ON o.id = n.id
   WHERE r.content_instance_id = n.id
     AND n."values" IS DISTINCT FROM o."values";
  INSERT INTO content_instance_refs (content_instance_id, ref_kind, ref)
  SELECT n.id, r.ref_kind, r.ref
    FROM new_rows n
    JOIN old_rows o ON o.id = n.id
   CROSS JOIN LATERAL caelo_content_instance_ref_rows(n."values") r
   WHERE n."values" IS DISTINCT FROM o."values"
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END
$fn$;

CREATE TRIGGER caelo_content_instance_refs_insert
  AFTER INSERT ON content_instances
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION caelo_content_instance_refs_on_insert();

CREATE TRIGGER caelo_content_instance_refs_update
  AFTER UPDATE ON content_instances
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION caelo_content_instance_refs_on_update();

/**
 * Rebuild the whole table from `content_instances` (the system op
 * `content_instances.rebuild_refs`). Returns how many rows it holds after.
 */
CREATE FUNCTION caelo_content_instance_refs_rebuild() RETURNS bigint
LANGUAGE plpgsql
AS $fn$
DECLARE
  n bigint;
BEGIN
  DELETE FROM content_instance_refs;
  INSERT INTO content_instance_refs (content_instance_id, ref_kind, ref)
  SELECT ci.id, r.ref_kind, r.ref
    FROM content_instances ci
   CROSS JOIN LATERAL caelo_content_instance_ref_rows(ci."values") r
  ON CONFLICT DO NOTHING;
  SELECT count(*) INTO n FROM content_instance_refs;
  RETURN n;
END
$fn$;

-- Backfill: every instance written before this migration.
INSERT INTO content_instance_refs (content_instance_id, ref_kind, ref)
SELECT ci.id, r.ref_kind, r.ref
  FROM content_instances ci
 CROSS JOIN LATERAL caelo_content_instance_ref_rows(ci."values") r
ON CONFLICT DO NOTHING;

ANALYZE content_instance_refs;

COMMIT;
