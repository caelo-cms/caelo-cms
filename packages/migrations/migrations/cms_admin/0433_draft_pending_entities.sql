-- SPDX-License-Identifier: MPL-2.0
--
-- 0433 — the draft head (issue #1268): what every branch has pending,
-- maintained at write time instead of recomputed from the history on
-- every read.
--
-- Pending is a property of a snapshot header (staged_at / undone_at NULL,
-- issue #620), and on the shared draft every chat shares ONE branch. So
-- "what has chat C changed" used to scan every unstaged snapshot of the
-- draft and resolve each one's owner chat (`caelo_chat_owner`) per row:
-- open chats x 11 subqueries x pending history for the Live Edit banner,
-- which hit the 60 s statement timeout on searchVIU (#1268).
--
-- draft_pending_entities holds one row per (branch, entity kind, entity,
-- owner chat): the newest pending snapshot that owner wrote of it. It is
-- derived state of the synchronous kind (docs/dev/state-and-changes.md,
-- rule 3): maintained in the writing transaction by statement-level
-- triggers on the snapshot tables, rebuildable from source
-- (caelo_draft_head_rebuild, the op chat.rebuild_draft_head), checked
-- "maintained == rebuilt" by the integration tests, and backfilled below.
--
-- One definition. caelo_draft_head_source() generates the SELECT of the
-- pending head per snapshot table; the write-time maintainers, the rebuild
-- and the consistency check all run that generated SQL, so they cannot
-- drift apart. The TypeScript mirror of the kinds (admin-core draft.ts,
-- DRAFT_HEAD_KINDS) is checked against caelo_draft_head_tables() by a test.
--
-- How the head stays exact on every path:
--   * a snapshot insert   — the inserted rows' pending heads are upserted;
--                           an older snapshot never replaces a newer head.
--   * Stage / undo        — an UPDATE of site_snapshots.staged_at /
--                           undone_at recomputes, per entity, the head rows
--                           that pointed at the changed headers (later
--                           pending writes stay pending, so a head row is
--                           recomputed, never just deleted).
--   * lock takeover       — re-points snapshot rows to a header on the
--                           taker's branch (an UPDATE of site_snapshot_id):
--                           the old and the new keys are recomputed.
--   * a delete            — only a deleted head row can change the head; its
--                           key is recomputed (also when the header is gone).
--   * a truncate          — the kind's rows go (every kind for the headers).
--   * subagent session GC — deleting a subagent's session changes whom its
--                           snapshots belong to (caelo_chat_owner), so the
--                           keys of its pending snapshots are recomputed.
-- Every recompute covers the entity's whole pending set, not only the row
-- the head points at: seo_changed depends on all of it.
-- Discarding an isolated chat leaves its branch's snapshots pending by
-- definition; its rows stay and every reader filters on open chats.
--
-- No counter column: a count over the head's (branch, owner) index,
-- bounded by that chat's own pending entities, replaces it. A counter on
-- chat_sessions would collide with the FOR SHARE the write path takes on
-- the chat row (#1253) and serialise the subagents of one chat. Writers
-- of different entities touch different head rows, so they never wait on
-- each other here; two writers of the same entity by the same owner wait
-- on its head row exactly as they already wait on the entity row itself.
--
-- RLS: ENABLE + FORCE. Every writer of a snapshot table maintains the
-- head, whatever actor it writes for (the same reason as entity_changes:
-- a policy that filtered such a write would silently leave the head
-- stale); a row is ids and timestamps only, never content. Reading needs
-- an authenticated session; which branches an actor may see is checked by
-- the Query API before an op runs (caelo_branch_visible, 0249).

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE draft_pending_entities (
  chat_branch_id        uuid        NOT NULL,
  -- admin-core draft.ts DRAFT_HEAD_KINDS: module, template, page,
  -- pageLayout, pageModuleContent, listType, list, pageType,
  -- contentInstance, theme, layoutBlock, pluginRow, layoutChrome.
  entity_kind           text        NOT NULL,
  -- The entity; for layoutChrome (a layout_modules.set header that names
  -- no entity row) the header itself.
  entity_id             uuid        NOT NULL,
  -- The block name of a layoutBlock (a layout's block is the entity);
  -- '' for every other kind.
  entity_sub            text        NOT NULL DEFAULT '',
  -- The chat that owns the change (a subagent's parent chat); NULL for a
  -- change written outside any chat.
  owner_chat_session_id uuid,
  -- The newest pending snapshot of the entity by this owner: its header,
  -- its row in the kind's snapshot table (NULL for layoutChrome), and the
  -- order key every overlay sorts by (header time, row time, row id).
  site_snapshot_id      uuid        NOT NULL,
  snapshot_row_id       uuid,
  header_created_at     timestamptz NOT NULL,
  row_created_at        timestamptz NOT NULL,
  -- Kind-specific facts of the head state, so readers need not open it:
  -- the page of a pageModuleContent; the parent and slug of a page (a
  -- pending move, #1269's tree reads); the plugin and table of a pluginRow.
  page_id               uuid,
  parent_page_id        uuid,
  slug                  text,
  plugin_id             uuid,
  table_name            text,
  -- A page whose pending changes by this owner include an SEO edit
  -- (op_kind pages_seo.*): the Stage list marks it (#1156) without walking
  -- the page's history.
  seo_changed           boolean     NOT NULL DEFAULT false
);

-- The key, and the lookup of a branch's pending state of given entities
-- (every draft overlay). A NULL owner is one key: Postgres 14 (the local
-- toolchain) has no NULLS NOT DISTINCT.
CREATE UNIQUE INDEX draft_pending_entities_key_idx ON draft_pending_entities
  (chat_branch_id, entity_kind, entity_id, entity_sub,
   (COALESCE(owner_chat_session_id, '00000000-0000-0000-0000-000000000000'::uuid)));
-- "What has chat C changed": the pill, the banner, the Stage list.
CREATE INDEX draft_pending_entities_owner_idx ON draft_pending_entities
  (chat_branch_id, owner_chat_session_id, entity_kind);
-- The maintainers find the head rows a Stage, an undo, a takeover or a
-- delete touched by the snapshot they point at.
CREATE INDEX draft_pending_entities_header_idx ON draft_pending_entities (site_snapshot_id);
CREATE INDEX draft_pending_entities_row_idx ON draft_pending_entities (snapshot_row_id)
  WHERE snapshot_row_id IS NOT NULL;
-- A plugin's pending rows of one table (plugin-host loadBranchRowStates):
-- never walks another plugin's rows.
CREATE INDEX draft_pending_entities_plugin_idx ON draft_pending_entities
  (chat_branch_id, plugin_id, table_name) WHERE entity_kind = 'pluginRow';

ALTER TABLE draft_pending_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE draft_pending_entities FORCE ROW LEVEL SECURITY;
CREATE POLICY draft_pending_entities_read ON draft_pending_entities FOR SELECT
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);
CREATE POLICY draft_pending_entities_insert ON draft_pending_entities FOR INSERT
  WITH CHECK (true);
CREATE POLICY draft_pending_entities_update ON draft_pending_entities FOR UPDATE
  USING (true) WITH CHECK (true);
CREATE POLICY draft_pending_entities_delete ON draft_pending_entities FOR DELETE
  USING (true);

/**
 * The snapshot tables the head covers: table, kind, entity column and the
 * expression that splits an entity further, as a format() template over the
 * row alias (`%1$s`): a layout's block, a plugin row's plugin and table
 * (plugin row ids are table-local, 0215). layoutChrome is not here: it is a
 * property of the header (caelo_draft_head_chrome_source).
 */
CREATE FUNCTION caelo_draft_head_tables()
  RETURNS TABLE (tbl text, kind text, key_col text, sub_expr text)
  LANGUAGE sql IMMUTABLE
  AS $$
    VALUES
      ('module_snapshots', 'module', 'module_id', ''),
      ('template_snapshots', 'template', 'template_id', ''),
      ('page_snapshots', 'page', 'page_id', ''),
      ('page_layout_snapshots', 'pageLayout', 'page_id', ''),
      ('page_module_content_snapshots', 'pageModuleContent', 'page_module_content_id', ''),
      ('list_type_snapshots', 'listType', 'list_type_id', ''),
      ('list_snapshots', 'list', 'list_id', ''),
      ('page_type_snapshots', 'pageType', 'page_type_id', ''),
      ('content_instance_snapshots', 'contentInstance', 'content_instance_id', ''),
      ('theme_snapshots', 'theme', 'theme_id', ''),
      ('layout_module_snapshots', 'layoutBlock', 'layout_id', '%1$s.block_name'),
      ('plugin_row_snapshots', 'pluginRow', 'row_id', '%1$s.plugin_id::text || ''/'' || %1$s.table_name')
  $$;

/** The sub-key expression of a head table over the row alias `p_alias`. */
CREATE FUNCTION caelo_draft_head_sub(p_sub_expr text, p_alias text)
  RETURNS text
  LANGUAGE sql IMMUTABLE
  AS $$
    SELECT CASE WHEN p_sub_expr = '' THEN '''''::text' ELSE format(p_sub_expr, p_alias) END
  $$;

/**
 * THE definition of a pending head, as SQL text for one snapshot table:
 * per (branch, entity, owner) the newest snapshot under a header that is on
 * a branch, not staged and not undone. `filter` narrows the rows (`true`
 * for a rebuild; a key or id set for the maintainers) and may use the
 * aliases `es` (snapshot row) and `h` (header). Column order is the table's.
 */
CREATE FUNCTION caelo_draft_head_source(p_tbl text, p_filter text)
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
    WHEN 'pluginRow' THEN 'NULL::uuid, NULL::uuid, NULL::text, es.plugin_id, es.table_name'
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

/**
 * The layoutChrome part of the definition: a pending layout_modules.set
 * header is a pending change of its own (layouts.create / update and the
 * chrome placement writes stamp it; most name no entity row), keyed by the
 * header itself — what the Stage list and the pill counted before #1268.
 */
CREATE FUNCTION caelo_draft_head_chrome_source(p_filter text)
  RETURNS text
  LANGUAGE sql IMMUTABLE
  AS $fn$
    SELECT format($q$
      SELECT h.chat_branch_id, 'layoutChrome'::text, h.id, ''::text,
             caelo_chat_owner(h.chat_task_id), h.id, NULL::uuid, h.created_at, h.created_at,
             NULL::uuid, NULL::uuid, NULL::text, NULL::uuid, NULL::text, false
        FROM site_snapshots h
       WHERE h.op_kind = 'layout_modules.set'
         AND h.chat_branch_id IS NOT NULL AND h.staged_at IS NULL AND h.undone_at IS NULL
         AND (%s)
    $q$, p_filter)
  $fn$;

/**
 * The upsert every maintainer runs: a newer head wins, an older one never
 * replaces it; `seo_changed` holds when any pending snapshot of the key says
 * so, whichever of the two is newer.
 */
CREATE FUNCTION caelo_draft_head_upsert_sql(p_source text)
  RETURNS text
  LANGUAGE sql IMMUTABLE
  AS $fn$
    SELECT format($q$
      INSERT INTO draft_pending_entities AS d
        (chat_branch_id, entity_kind, entity_id, entity_sub, owner_chat_session_id,
         site_snapshot_id, snapshot_row_id, header_created_at, row_created_at,
         page_id, parent_page_id, slug, plugin_id, table_name, seo_changed)
      %1$s
      ON CONFLICT (chat_branch_id, entity_kind, entity_id, entity_sub,
                   (COALESCE(owner_chat_session_id, '00000000-0000-0000-0000-000000000000'::uuid)))
      DO UPDATE SET
        site_snapshot_id = CASE WHEN %2$s THEN EXCLUDED.site_snapshot_id ELSE d.site_snapshot_id END,
        snapshot_row_id = CASE WHEN %2$s THEN EXCLUDED.snapshot_row_id ELSE d.snapshot_row_id END,
        header_created_at = CASE WHEN %2$s THEN EXCLUDED.header_created_at ELSE d.header_created_at END,
        row_created_at = CASE WHEN %2$s THEN EXCLUDED.row_created_at ELSE d.row_created_at END,
        page_id = CASE WHEN %2$s THEN EXCLUDED.page_id ELSE d.page_id END,
        parent_page_id = CASE WHEN %2$s THEN EXCLUDED.parent_page_id ELSE d.parent_page_id END,
        slug = CASE WHEN %2$s THEN EXCLUDED.slug ELSE d.slug END,
        plugin_id = CASE WHEN %2$s THEN EXCLUDED.plugin_id ELSE d.plugin_id END,
        table_name = CASE WHEN %2$s THEN EXCLUDED.table_name ELSE d.table_name END,
        seo_changed = d.seo_changed OR EXCLUDED.seo_changed
    $q$, p_source,
      -- EXCLUDED is newer than the stored head.
      '(EXCLUDED.header_created_at, EXCLUDED.row_created_at,
        COALESCE(EXCLUDED.snapshot_row_id, EXCLUDED.site_snapshot_id))
     > (d.header_created_at, d.row_created_at, COALESCE(d.snapshot_row_id, d.site_snapshot_id))')
  $fn$;

/**
 * Recompute the head of the given keys (kind + parallel arrays of branch,
 * entity and sub) from source: delete them, then insert what the source
 * says now. Two statements on purpose: under READ COMMITTED the insert
 * takes a fresh snapshot after the delete waited out any concurrent writer
 * of the same rows, and the upsert keeps a newer head that writer added
 * meanwhile. A key with nothing pending simply ends up without a row.
 */
CREATE FUNCTION caelo_draft_head_recompute(
  p_kind text, p_branches uuid[], p_entities uuid[], p_subs text[]
) RETURNS void
  LANGUAGE plpgsql
  AS $fn$
DECLARE
  t record;
BEGIN
  IF p_entities IS NULL OR cardinality(p_entities) = 0 THEN RETURN; END IF;
  DELETE FROM draft_pending_entities d
   USING unnest(p_branches, p_entities, p_subs) AS k(b, e, s)
   WHERE d.entity_kind = p_kind AND d.chat_branch_id = k.b
     AND d.entity_id = k.e AND d.entity_sub = k.s;
  IF p_kind = 'layoutChrome' THEN
    EXECUTE caelo_draft_head_upsert_sql(caelo_draft_head_chrome_source(
      'h.id = ANY($2) AND (h.chat_branch_id, h.id) IN (SELECT * FROM unnest($1, $2))'))
      USING p_branches, p_entities;
    RETURN;
  END IF;
  SELECT * INTO t FROM caelo_draft_head_tables() r WHERE r.kind = p_kind;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'caelo_draft_head_recompute: unknown kind %', p_kind;
  END IF;
  -- es.<key> = ANY($2) walks the kind's (key, created_at DESC) index (0430);
  -- the tuple filter keeps the exact (branch, entity, sub) keys.
  EXECUTE caelo_draft_head_upsert_sql(caelo_draft_head_source(t.tbl, format(
    'es.%1$I = ANY($2) AND (h.chat_branch_id, es.%1$I, %2$s) IN (SELECT * FROM unnest($1, $2, $3))',
    t.key_col, caelo_draft_head_sub(t.sub_expr, 'es'))))
    USING p_branches, p_entities, p_subs;
END
$fn$;

/**
 * Recompute every head key the given headers can affect, on the given
 * branches: the entities recorded under the headers (a Stage or an undo of
 * an older snapshot changes what is pending of them, `seo_changed` too,
 * even when the head points at a newer one), the head rows that point at
 * the headers (their rows may be gone already), and the headers as
 * layoutChrome. Shared by the header maintainer and the session maintainer.
 */
CREATE FUNCTION caelo_draft_head_recompute_headers(p_headers uuid[], p_branches uuid[])
  RETURNS void
  LANGUAGE plpgsql
  AS $fn$
DECLARE
  t record;
  k record;
  v_b uuid[];
  v_e uuid[];
  v_s text[];
BEGIN
  IF p_headers IS NULL OR cardinality(p_headers) = 0 THEN RETURN; END IF;
  FOR k IN
    SELECT d.entity_kind, array_agg(d.chat_branch_id) AS b, array_agg(d.entity_id) AS e,
           array_agg(d.entity_sub) AS s
      FROM draft_pending_entities d
     WHERE d.site_snapshot_id = ANY(p_headers)
     GROUP BY d.entity_kind
  LOOP
    PERFORM caelo_draft_head_recompute(k.entity_kind, k.b, k.e, k.s);
  END LOOP;
  IF p_branches IS NULL OR cardinality(p_branches) = 0 THEN RETURN; END IF;
  FOR t IN SELECT * FROM caelo_draft_head_tables() LOOP
    EXECUTE format($q$
      SELECT array_agg(b.id), array_agg(k.e), array_agg(k.s)
        FROM (SELECT DISTINCT es.%1$I AS e, %2$s AS s FROM %3$I es
               WHERE es.site_snapshot_id = ANY($1)) k
        CROSS JOIN unnest($2) AS b(id)
    $q$, t.key_col, caelo_draft_head_sub(t.sub_expr, 'es'), t.tbl)
      INTO v_b, v_e, v_s USING p_headers, p_branches;
    PERFORM caelo_draft_head_recompute(t.kind, v_b, v_e, v_s);
  END LOOP;
  SELECT array_agg(b.id), array_agg(h.id), array_agg(''::text)
    INTO v_b, v_e, v_s
    FROM unnest(p_headers) AS h(id) CROSS JOIN unnest(p_branches) AS b(id);
  PERFORM caelo_draft_head_recompute('layoutChrome', v_b, v_e, v_s);
END
$fn$;

/**
 * Maintainer on each snapshot table (statement level, transition tables).
 * TG_ARGV: kind, entity column, sub-key template (caelo_draft_head_tables).
 */
CREATE FUNCTION caelo_draft_head_rows() RETURNS trigger
  LANGUAGE plpgsql
  AS $fn$
DECLARE
  a_kind text := TG_ARGV[0];
  a_key  text := TG_ARGV[1];
  a_sub  text := TG_ARGV[2];
  v_b uuid[];
  v_e uuid[];
  v_s text[];
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    DELETE FROM draft_pending_entities WHERE entity_kind = a_kind;
    RETURN NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    EXECUTE caelo_draft_head_upsert_sql(caelo_draft_head_source(
      TG_TABLE_NAME, 'es.id IN (SELECT n.id FROM new_rows n)'));
    RETURN NULL;
  END IF;

  -- UPDATE / DELETE: every head row of a changed row's entity (on any
  -- branch) is recomputed — the head and `seo_changed` depend on all of
  -- the entity's pending snapshots, not only the one the head points at —
  -- plus, for an UPDATE, wherever a changed row now sits under a pending
  -- branch header (its new key — a takeover).
  EXECUTE format($q$
    SELECT array_agg(k.b), array_agg(k.e), array_agg(k.s) FROM (
      SELECT d.chat_branch_id AS b, d.entity_id AS e, d.entity_sub AS s
        FROM draft_pending_entities d
       WHERE d.entity_kind = %1$L
         AND (d.entity_id, d.entity_sub) IN (SELECT o.%2$I, %3$s FROM old_rows o)
      %4$s
    ) k
  $q$, a_kind, a_key, caelo_draft_head_sub(a_sub, 'o'),
    CASE WHEN TG_OP = 'UPDATE' THEN format($u$
      UNION
      SELECT h.chat_branch_id, n.%1$I, %2$s
        FROM new_rows n JOIN site_snapshots h ON h.id = n.site_snapshot_id
       WHERE h.chat_branch_id IS NOT NULL AND h.staged_at IS NULL AND h.undone_at IS NULL
    $u$, a_key, caelo_draft_head_sub(a_sub, 'n')) ELSE '' END) INTO v_b, v_e, v_s;
  PERFORM caelo_draft_head_recompute(a_kind, v_b, v_e, v_s);
  RETURN NULL;
END
$fn$;

/**
 * Maintainer on site_snapshots: layoutChrome headers, and every head key a
 * Stage, an undo or a re-tagged header changes.
 */
CREATE FUNCTION caelo_draft_head_headers() RETURNS trigger
  LANGUAGE plpgsql
  AS $fn$
DECLARE
  v_changed uuid[];
  v_old uuid[];
  v_new uuid[];
  v_branches uuid[];
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    DELETE FROM draft_pending_entities;
    RETURN NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF EXISTS (SELECT 1 FROM new_rows n WHERE n.op_kind = 'layout_modules.set') THEN
      EXECUTE caelo_draft_head_upsert_sql(caelo_draft_head_chrome_source(
        'h.id IN (SELECT n.id FROM new_rows n)'));
    END IF;
    RETURN NULL;
  END IF;

  IF TG_OP = 'DELETE' THEN
    SELECT array_agg(o.id), array_agg(DISTINCT o.chat_branch_id)
                              FILTER (WHERE o.chat_branch_id IS NOT NULL)
      INTO v_changed, v_branches FROM old_rows o;
  ELSE
    -- Only a change of what makes a header pending, or of whose it is,
    -- moves the head (archiving a header, say, does not). Both the branch
    -- the header was on and the one it is on now are recomputed.
    SELECT array_agg(n.id), array_agg(o.chat_branch_id), array_agg(n.chat_branch_id)
      INTO v_changed, v_old, v_new
      FROM new_rows n JOIN old_rows o ON o.id = n.id
     WHERE (n.chat_branch_id, n.chat_task_id, n.staged_at, n.undone_at, n.op_kind)
           IS DISTINCT FROM (o.chat_branch_id, o.chat_task_id, o.staged_at, o.undone_at, o.op_kind);
    v_branches := ARRAY(SELECT DISTINCT b FROM unnest(v_old || v_new) AS b WHERE b IS NOT NULL);
  END IF;
  PERFORM caelo_draft_head_recompute_headers(v_changed, v_branches);
  RETURN NULL;
END
$fn$;

/**
 * Maintainer on chat_sessions: a snapshot's owner is resolved through its
 * chat task's session (caelo_chat_owner: a subagent's task belongs to its
 * parent chat). Deleting a subagent session (subagent_runs GC) changes that
 * answer for its pending snapshots, so their keys are recomputed.
 */
CREATE FUNCTION caelo_draft_head_sessions() RETURNS trigger
  LANGUAGE plpgsql
  AS $fn$
DECLARE
  v_headers uuid[];
  v_branches uuid[];
BEGIN
  SELECT array_agg(h.id), array_agg(DISTINCT h.chat_branch_id)
    INTO v_headers, v_branches
    FROM site_snapshots h
   WHERE h.chat_task_id IN (SELECT o.id FROM old_rows o WHERE o.parent_chat_session_id IS NOT NULL)
     AND h.chat_branch_id IS NOT NULL AND h.staged_at IS NULL AND h.undone_at IS NULL;
  PERFORM caelo_draft_head_recompute_headers(v_headers, v_branches);
  RETURN NULL;
END
$fn$;

/** The whole head computed from source, in the table's column order. */
CREATE FUNCTION caelo_draft_head_computed() RETURNS SETOF draft_pending_entities
  LANGUAGE plpgsql STABLE
  AS $fn$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT * FROM caelo_draft_head_tables() LOOP
    RETURN QUERY EXECUTE caelo_draft_head_source(t.tbl, 'true');
  END LOOP;
  RETURN QUERY EXECUTE caelo_draft_head_chrome_source('true');
END
$fn$;

/** Rebuild the head from source; returns the number of head rows. */
CREATE FUNCTION caelo_draft_head_rebuild() RETURNS int
  LANGUAGE plpgsql
  AS $fn$
DECLARE
  n int;
BEGIN
  DELETE FROM draft_pending_entities;
  INSERT INTO draft_pending_entities SELECT * FROM caelo_draft_head_computed();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$fn$;

DO $$
DECLARE
  t record;
  args text;
BEGIN
  FOR t IN SELECT * FROM caelo_draft_head_tables() LOOP
    args := format('%L, %L, %L', t.kind, t.key_col, t.sub_expr);
    EXECUTE format('CREATE TRIGGER caelo_draft_head_insert AFTER INSERT ON %I
                      REFERENCING NEW TABLE AS new_rows
                      FOR EACH STATEMENT EXECUTE FUNCTION caelo_draft_head_rows(%s)', t.tbl, args);
    EXECUTE format('CREATE TRIGGER caelo_draft_head_update AFTER UPDATE ON %I
                      REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
                      FOR EACH STATEMENT EXECUTE FUNCTION caelo_draft_head_rows(%s)', t.tbl, args);
    EXECUTE format('CREATE TRIGGER caelo_draft_head_delete AFTER DELETE ON %I
                      REFERENCING OLD TABLE AS old_rows
                      FOR EACH STATEMENT EXECUTE FUNCTION caelo_draft_head_rows(%s)', t.tbl, args);
    EXECUTE format('CREATE TRIGGER caelo_draft_head_truncate AFTER TRUNCATE ON %I
                      FOR EACH STATEMENT EXECUTE FUNCTION caelo_draft_head_rows(%s)', t.tbl, args);
  END LOOP;
END
$$;

CREATE TRIGGER caelo_draft_head_insert AFTER INSERT ON site_snapshots
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION caelo_draft_head_headers();
CREATE TRIGGER caelo_draft_head_update AFTER UPDATE ON site_snapshots
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION caelo_draft_head_headers();
CREATE TRIGGER caelo_draft_head_delete AFTER DELETE ON site_snapshots
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION caelo_draft_head_headers();
CREATE TRIGGER caelo_draft_head_truncate AFTER TRUNCATE ON site_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION caelo_draft_head_headers();
CREATE TRIGGER caelo_draft_head_delete AFTER DELETE ON chat_sessions
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION caelo_draft_head_sessions();

-- Backfill (rule 3): the head of every branch as the history says now.
SELECT caelo_draft_head_rebuild();

COMMIT;
