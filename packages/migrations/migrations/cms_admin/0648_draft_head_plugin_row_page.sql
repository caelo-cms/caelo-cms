-- SPDX-License-Identifier: MPL-2.0
--
-- 0648 — the draft head names the page a pending plugin row belongs to
-- (issue #1411).
--
-- A plugin can give a page another URL on a branch without a page
-- snapshot: a locale variant linked in a chat is a plugin row, and a main
-- page's `current_path` only moves at the merge. The branch views of a
-- page (humanising, canonicalising, pages.list, the preview) recompose a
-- path only when they know it may differ, and to know that per page they
-- read the head. The change journal itself cannot answer: it is a feed
-- with a 24-hour retention, while a pending row stays pending for as long
-- as nobody stages it. The head is the journal's synchronous derived
-- state of exactly that question (docs/dev/state-and-changes.md).
--
-- The head row of a pluginRow carries the `page_id` column of the row's
-- newest pending state, also when that state deletes the row: an unlinked
-- page moves too. A state's values are the plugin's own and hold anything
-- in a column of that name, so a value that is no uuid is no page, never
-- a failed plugin write. "maintained == rebuilt" (scripts/test-preload.ts)
-- covers the new values: the rebuild runs the same definition.
--
-- Read by one predicate: a branch, the URL plugins, optionally given
-- pages. The index keeps that read at the size of the request instead of
-- the size of the branch's pending plugin rows, which on the shared draft
-- is every translated page since the last Stage.
--
-- Expand-only: a function, a changed definition, a backfill of rows that
-- held NULL here, one partial index. The previous image reads none of it.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

/** The page a plugin row state names; NULL when it names none. */
CREATE FUNCTION caelo_plugin_row_page_id(p_state jsonb)
  RETURNS uuid
  LANGUAGE sql IMMUTABLE
  AS $fn$
    SELECT CASE
      WHEN p_state->'values'->>'page_id'
           ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (p_state->'values'->>'page_id')::uuid
    END
  $fn$;

/**
 * THE definition of a pending head, as SQL text for one snapshot table:
 * per (branch, entity, owner) the newest snapshot under a header that is on
 * a branch, not staged and not undone. `filter` narrows the rows (`true`
 * for a rebuild; a key or id set for the maintainers) and may use the
 * aliases `es` (snapshot row) and `h` (header). Column order is the table's.
 */
CREATE OR REPLACE FUNCTION caelo_draft_head_source(p_tbl text, p_filter text)
  RETURNS text
  LANGUAGE plpgsql STABLE
  AS $fn$
DECLARE
  t record;
  v_extra text;
  v_seo text;
BEGIN
  SELECT * INTO t FROM caelo_draft_head_tables() r WHERE r.tbl = p_tbl;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'caelo_draft_head_source: % is not a draft head table', p_tbl;
  END IF;
  v_extra := CASE t.kind
    WHEN 'page' THEN
      'NULL::uuid, NULLIF(es.state->>''parentPageId'', '''')::uuid, es.state->>''slug'', NULL::uuid, NULL::text'
    WHEN 'pageModuleContent' THEN 'es.page_id, NULL::uuid, NULL::text, NULL::uuid, NULL::text'
    WHEN 'pluginRow' THEN 'caelo_plugin_row_page_id(es.state), NULL::uuid, NULL::text, es.plugin_id, es.table_name'
    ELSE 'NULL::uuid, NULL::uuid, NULL::text, NULL::uuid, NULL::text'
  END;
  -- Over every pending snapshot of the (branch, entity, owner), not only
  -- the newest: the window runs before DISTINCT ON keeps the newest.
  v_seo := CASE WHEN t.kind = 'page'
    THEN 'bool_or(s.op_kind LIKE ''pages\_seo.%'') OVER (PARTITION BY s.chat_branch_id, s.entity_id, s.entity_sub, s.owner)'
    ELSE 'false' END;
  RETURN format($q$
    SELECT DISTINCT ON (s.chat_branch_id, s.entity_id, s.entity_sub, s.owner)
           s.chat_branch_id, %1$L::text, s.entity_id, s.entity_sub, s.owner,
           s.site_snapshot_id, s.snapshot_row_id, s.header_created_at, s.row_created_at,
           s.page_id, s.parent_page_id, s.slug, s.plugin_id, s.table_name, %7$s
      FROM (
        SELECT h.chat_branch_id, es.%2$I AS entity_id, %3$s AS entity_sub,
               caelo_chat_owner(h.chat_task_id) AS owner,
               h.id AS site_snapshot_id, es.id AS snapshot_row_id,
               h.created_at AS header_created_at, es.created_at AS row_created_at,
               %4$s, h.op_kind
          FROM %5$I es JOIN site_snapshots h ON h.id = es.site_snapshot_id
         WHERE h.chat_branch_id IS NOT NULL AND h.staged_at IS NULL AND h.undone_at IS NULL
           AND (%6$s)
      ) s(chat_branch_id, entity_id, entity_sub, owner, site_snapshot_id, snapshot_row_id,
          header_created_at, row_created_at, page_id, parent_page_id, slug, plugin_id, table_name,
          op_kind)
     ORDER BY s.chat_branch_id, s.entity_id, s.entity_sub, s.owner,
              s.header_created_at DESC, s.row_created_at DESC, s.snapshot_row_id DESC
  $q$, t.kind, t.key_col, caelo_draft_head_sub(t.sub_expr, 'es'), v_extra, t.tbl, p_filter, v_seo);
END
$fn$;

UPDATE draft_pending_entities d
   SET page_id = caelo_plugin_row_page_id(s.state)
  FROM plugin_row_snapshots s
 WHERE d.entity_kind = 'pluginRow' AND s.id = d.snapshot_row_id;

CREATE INDEX draft_pending_entities_plugin_page_idx ON draft_pending_entities
  (chat_branch_id, plugin_id, page_id)
  WHERE entity_kind = 'pluginRow' AND page_id IS NOT NULL;

COMMIT;
