-- SPDX-License-Identifier: MPL-2.0
--
-- 0658 — the content instances that hold a field value, for a write hint
-- that reads what it finds (issue #1062, #1269).
--
-- After a content write the AI is told when a written value now sits in
-- three or more private instances of the same module (the repeated-value
-- hint, `content_instances.list_module_peers`). It read every instance of
-- the module to find them: a page module with one instance per page is the
-- whole site, so on the 50k-page scale gate each AI content write read
-- 50,000 instances and counted their placements, the heaviest load of the
-- run. A containment index on the values cannot serve it: under FORCEd row
-- level security `@>` is not leakproof, so the planner may not use it as an
-- index condition and scans the table. Equality of text is leakproof.
--
-- Two tables of synchronous derived state (rule 3 of
-- docs/dev/state-and-changes.md), maintained by statement-level triggers in
-- the writer's own transaction, like the page search words (0612):
--
--   content_value_hashes                one row per (module, field, hash,
--                                       instance) of every instance row:
--                                       the md5 of each top-level field
--                                       value of 20 or more characters.
--   draft_pending_content_value_hashes  one row per (branch, head row,
--                                       field, hash) of the draft head
--                                       (0477): the same hashes of each
--                                       pending instance state, so a
--                                       branch's lookup reads only its own
--                                       pending instances.
--
-- The hash is md5 of the value's jsonb text (keys in jsonb's canonical
-- order), a string first trimmed like the guard trims it
-- (`caelo_content_value_norm`), so a lookup hashes the written value the
-- same way and confirms each candidate on its values. Short values are left out: the hint is
-- about copied prose and lists, never "Learn more".
--
-- Rebuild: `caelo_content_value_hashes_rebuild()` (the system op
-- content_instances.rebuild_value_hashes); the test preload checks
-- maintained == rebuilt after every integration file. Backfilled below.
--
-- Expand-only: new tables, functions and triggers. The previous image never
-- reads them; its instance and draft-head writes fire the triggers.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

/**
 * A field value as the hint compares it: a string without the leading and
 * trailing white space JavaScript's String.prototype.trim removes (the
 * guard's `valueKey`), any other value as it is.
 */
CREATE FUNCTION caelo_content_value_norm(v jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $fn$
  SELECT CASE WHEN jsonb_typeof(v) = 'string'
    THEN to_jsonb(regexp_replace(v #>> '{}',
      '^[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$',
      '', 'g'))
    ELSE v END
$fn$;

/** The hashed field values of `vals`: md5 of each normalised top-level value of 20+ characters. */
CREATE FUNCTION caelo_content_value_hashes(vals jsonb)
  RETURNS TABLE (field text, hash text)
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $fn$
  SELECT e.key, md5(n.v::text)
    FROM jsonb_each(CASE WHEN jsonb_typeof(vals) = 'object' THEN vals ELSE '{}'::jsonb END) e
   CROSS JOIN LATERAL (SELECT caelo_content_value_norm(e.value) AS v) n
   WHERE length(n.v::text) >= 20
$fn$;

CREATE TABLE content_value_hashes (
  module_id   uuid NOT NULL,
  field       text COLLATE "C" NOT NULL,
  hash        text COLLATE "C" NOT NULL,
  instance_id uuid NOT NULL REFERENCES content_instances(id) ON DELETE CASCADE,
  PRIMARY KEY (module_id, field, hash, instance_id)
);
-- The FK, and the re-hash of one instance.
CREATE INDEX content_value_hashes_instance_idx ON content_value_hashes (instance_id);

CREATE TABLE draft_pending_content_value_hashes (
  chat_branch_id  uuid NOT NULL,
  snapshot_row_id uuid NOT NULL REFERENCES content_instance_snapshots(id) ON DELETE CASCADE,
  field           text COLLATE "C" NOT NULL,
  hash            text COLLATE "C" NOT NULL,
  instance_id     uuid NOT NULL,
  PRIMARY KEY (chat_branch_id, snapshot_row_id, field, hash)
);
-- The lookup: a branch's pending instances by field value.
CREATE INDEX draft_pending_content_value_hashes_lookup_idx ON draft_pending_content_value_hashes
  (chat_branch_id, field, hash, instance_id);
-- The FK.
CREATE INDEX draft_pending_content_value_hashes_row_idx
  ON draft_pending_content_value_hashes (snapshot_row_id);

-- Same scope as content_instances' readers: any authenticated session; the
-- lookup confirms every candidate on the instance row in the caller's view.
ALTER TABLE content_value_hashes ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_value_hashes FORCE ROW LEVEL SECURITY;
CREATE POLICY content_value_hashes_authenticated_scope ON content_value_hashes
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);
-- Maintained by the draft head's own triggers, whatever actor writes a
-- snapshot (the reason 0477 admits every writer): a policy that filtered
-- such a write would leave the hashes stale.
ALTER TABLE draft_pending_content_value_hashes ENABLE ROW LEVEL SECURITY;
ALTER TABLE draft_pending_content_value_hashes FORCE ROW LEVEL SECURITY;
CREATE POLICY draft_pending_content_value_hashes_read ON draft_pending_content_value_hashes
  FOR SELECT USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);
CREATE POLICY draft_pending_content_value_hashes_insert ON draft_pending_content_value_hashes
  FOR INSERT WITH CHECK (true);
CREATE POLICY draft_pending_content_value_hashes_delete ON draft_pending_content_value_hashes
  FOR DELETE USING (true);

/** Trigger: hash the values of inserted instances. */
CREATE FUNCTION caelo_content_value_hashes_on_insert() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  INSERT INTO content_value_hashes (module_id, field, hash, instance_id)
  SELECT n.module_id, h.field, h.hash, n.id
    FROM new_rows n CROSS JOIN LATERAL caelo_content_value_hashes(n."values") h
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END
$fn$;

/** Trigger: re-hash instances whose values (or module) changed. */
CREATE FUNCTION caelo_content_value_hashes_on_update() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  DELETE FROM content_value_hashes s
   USING new_rows n JOIN old_rows o ON o.id = n.id
   WHERE s.instance_id = n.id
     AND (n."values", n.module_id) IS DISTINCT FROM (o."values", o.module_id);
  INSERT INTO content_value_hashes (module_id, field, hash, instance_id)
  SELECT n.module_id, h.field, h.hash, n.id
    FROM new_rows n JOIN old_rows o ON o.id = n.id
   CROSS JOIN LATERAL caelo_content_value_hashes(n."values") h
   WHERE (n."values", n.module_id) IS DISTINCT FROM (o."values", o.module_id)
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END
$fn$;

CREATE TRIGGER caelo_content_value_hashes_insert
  AFTER INSERT ON content_instances
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION caelo_content_value_hashes_on_insert();
CREATE TRIGGER caelo_content_value_hashes_update
  AFTER UPDATE ON content_instances
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION caelo_content_value_hashes_on_update();
-- A deleted instance's hashes go with it (ON DELETE CASCADE).

/** The hashes of the pending instance states `p_rows` (head rows of the draft) points at. */
CREATE FUNCTION caelo_draft_content_value_hashes_insert(p_branches uuid[], p_rows uuid[])
  RETURNS void
LANGUAGE sql
AS $fn$
  INSERT INTO draft_pending_content_value_hashes
    (chat_branch_id, snapshot_row_id, field, hash, instance_id)
  SELECT k.b, s.id, h.field, h.hash, s.content_instance_id
    FROM unnest(p_branches, p_rows) AS k(b, r)
    JOIN content_instance_snapshots s ON s.id = k.r
   CROSS JOIN LATERAL caelo_content_value_hashes(s.state -> 'values') h
  ON CONFLICT DO NOTHING
$fn$;

/** Trigger: hashes for inserted content-instance head rows. */
CREATE FUNCTION caelo_draft_content_value_hashes_on_insert() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  PERFORM caelo_draft_content_value_hashes_insert(
    ARRAY(SELECT n.chat_branch_id FROM new_rows n
           WHERE n.entity_kind = 'contentInstance' AND n.snapshot_row_id IS NOT NULL
           ORDER BY n.snapshot_row_id),
    ARRAY(SELECT n.snapshot_row_id FROM new_rows n
           WHERE n.entity_kind = 'contentInstance' AND n.snapshot_row_id IS NOT NULL
           ORDER BY n.snapshot_row_id));
  RETURN NULL;
END
$fn$;

/**
 * Trigger: a head row that now points at another snapshot row (a newer
 * pending state, a takeover to another branch) drops the old row's hashes
 * and gets the new one's.
 */
CREATE FUNCTION caelo_draft_content_value_hashes_on_update() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  DELETE FROM draft_pending_content_value_hashes w
   USING old_rows o
   WHERE o.entity_kind = 'contentInstance' AND o.snapshot_row_id IS NOT NULL
     AND w.chat_branch_id = o.chat_branch_id AND w.snapshot_row_id = o.snapshot_row_id
     -- A head row of the branch still pointing at the row (this one
     -- unchanged in that respect, or another owner's) keeps its hashes.
     AND NOT EXISTS (
       SELECT 1 FROM draft_pending_entities d
        WHERE d.entity_kind = 'contentInstance' AND d.chat_branch_id = o.chat_branch_id
          AND d.snapshot_row_id = o.snapshot_row_id);
  PERFORM caelo_draft_content_value_hashes_insert(
    ARRAY(SELECT n.chat_branch_id FROM new_rows n
           WHERE n.entity_kind = 'contentInstance' AND n.snapshot_row_id IS NOT NULL
           ORDER BY n.snapshot_row_id),
    ARRAY(SELECT n.snapshot_row_id FROM new_rows n
           WHERE n.entity_kind = 'contentInstance' AND n.snapshot_row_id IS NOT NULL
           ORDER BY n.snapshot_row_id));
  RETURN NULL;
END
$fn$;

/** Trigger: deleted content-instance head rows drop their hashes. */
CREATE FUNCTION caelo_draft_content_value_hashes_on_delete() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  DELETE FROM draft_pending_content_value_hashes w
   USING old_rows o
   WHERE o.entity_kind = 'contentInstance' AND o.snapshot_row_id IS NOT NULL
     AND w.chat_branch_id = o.chat_branch_id AND w.snapshot_row_id = o.snapshot_row_id
     AND NOT EXISTS (
       SELECT 1 FROM draft_pending_entities d
        WHERE d.entity_kind = 'contentInstance' AND d.chat_branch_id = o.chat_branch_id
          AND d.snapshot_row_id = o.snapshot_row_id);
  RETURN NULL;
END
$fn$;

/** Trigger: a truncate of the draft head truncates its hashes. */
CREATE FUNCTION caelo_draft_content_value_hashes_on_truncate() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  DELETE FROM draft_pending_content_value_hashes;
  RETURN NULL;
END
$fn$;

CREATE TRIGGER caelo_draft_content_value_hashes_insert
  AFTER INSERT ON draft_pending_entities
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION caelo_draft_content_value_hashes_on_insert();
CREATE TRIGGER caelo_draft_content_value_hashes_update
  AFTER UPDATE ON draft_pending_entities
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION caelo_draft_content_value_hashes_on_update();
CREATE TRIGGER caelo_draft_content_value_hashes_delete
  AFTER DELETE ON draft_pending_entities
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION caelo_draft_content_value_hashes_on_delete();
CREATE TRIGGER caelo_draft_content_value_hashes_truncate
  AFTER TRUNCATE ON draft_pending_entities
  FOR EACH STATEMENT EXECUTE FUNCTION caelo_draft_content_value_hashes_on_truncate();

/**
 * The hashes both tables should hold, from source: the instance rows and
 * the content-instance head rows of the draft. Shared by the rebuild and
 * the drift check.
 */
CREATE FUNCTION caelo_content_value_hashes_expected()
  RETURNS TABLE (t text, chat_branch_id uuid, snapshot_row_id uuid, module_id uuid,
                 field text, hash text, instance_id uuid)
LANGUAGE sql STABLE
AS $fn$
  SELECT 'live', NULL::uuid, NULL::uuid, ci.module_id, h.field, h.hash, ci.id
    FROM content_instances ci CROSS JOIN LATERAL caelo_content_value_hashes(ci."values") h
  UNION
  SELECT 'draft', d.chat_branch_id, s.id, NULL::uuid, h.field, h.hash, s.content_instance_id
    FROM draft_pending_entities d
    JOIN content_instance_snapshots s ON s.id = d.snapshot_row_id
   CROSS JOIN LATERAL caelo_content_value_hashes(s.state -> 'values') h
   WHERE d.entity_kind = 'contentInstance'
$fn$;

/** Rebuild both hash tables from source; returns how many rows they hold after. */
CREATE FUNCTION caelo_content_value_hashes_rebuild() RETURNS bigint
LANGUAGE plpgsql
AS $fn$
DECLARE
  n bigint;
BEGIN
  DELETE FROM content_value_hashes;
  DELETE FROM draft_pending_content_value_hashes;
  INSERT INTO content_value_hashes (module_id, field, hash, instance_id)
  SELECT e.module_id, e.field, e.hash, e.instance_id
    FROM caelo_content_value_hashes_expected() e WHERE e.t = 'live';
  INSERT INTO draft_pending_content_value_hashes
    (chat_branch_id, snapshot_row_id, field, hash, instance_id)
  SELECT e.chat_branch_id, e.snapshot_row_id, e.field, e.hash, e.instance_id
    FROM caelo_content_value_hashes_expected() e WHERE e.t = 'draft';
  SELECT (SELECT count(*) FROM content_value_hashes)
       + (SELECT count(*) FROM draft_pending_content_value_hashes) INTO n;
  RETURN n;
END
$fn$;

SELECT caelo_content_value_hashes_rebuild();

ANALYZE content_value_hashes;
ANALYZE draft_pending_content_value_hashes;

COMMIT;
