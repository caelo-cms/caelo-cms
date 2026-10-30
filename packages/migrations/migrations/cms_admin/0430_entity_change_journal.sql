-- SPDX-License-Identifier: MPL-2.0
--
-- 0430 — one entity change journal for cms_admin (issue #1267).
--
-- The contract is docs/dev/state-and-changes.md; the readable registry of
-- journaled and exempt tables is packages/shared/src/change-journal.ts, and
-- a CI test holds the two in step.
--
-- Before this, seven mechanisms told consumers "what changed" (the
-- domain_events outbox, the font_usage_changes xid log, the
-- site_view_generation counter, an in-process module-change push, ...).
-- None was general, so each new consumer invented another. Now every
-- committed change to a journaled table leaves rows here:
--
--   entity_changes — one insert-only row per changed row of a journaled
--     table per transaction: (xid, table_name, row_id) is the key. Written
--     by generic statement-level triggers through transition tables
--     (caelo_journal_rows), attached per table by caelo_journal_attach.
--     Different transactions insert different keys, so writers never wait
--     on each other through the journal; a second statement of the SAME
--     transaction on the same row merges into its row (changed columns
--     unioned) — the only conflict there can be. A rolled-back write
--     leaves no row. An UPDATE that changed nothing (or only updated_at)
--     leaves none either.
--
-- Why triggers, not the snapshot emitter: the emitter is not a complete
-- chokepoint. Child snapshots are inserted outside it (layout modules,
-- publish, the link migration), Stage / undo / lock takeover are UPDATEs
-- that re-point rows, and media, site_defaults, plugins, grants and
-- redirects change what editors see without a snapshot at all. A trigger
-- on a registered table set counts an op, a Stage, an undo, a migration
-- and a psql session alike — the reason 0394 used triggers too.
--
-- Attribution: the Query API's execute() sets transaction-local settings
-- (caelo.chat_branch_id, caelo.chat_task_id, caelo.op_name); the trigger
-- resolves the owner chat once per written row (caelo_chat_owner). For
-- snapshot tables branch, chat and snapshot id come from the snapshot's
-- own header, so they are exact on every path, including writes outside an
-- op. Live entity rows carry no snapshot id: handlers write the live row
-- before they emit its snapshot, so the snapshot row of the same
-- transaction (same xid, kind and row_id) is where a consumer finds it.
--
--   entity_change_horizons — garbage collection deletes rows older than
--     the retention window, never past the cursor of a persisted consumer
--     that is not stalled, and records the newest xid it deleted. A cursor
--     whose snapshot xmin is at or below a horizon may have lost rows and
--     must run its rebuild instead (rule 4 of the contract).
--
--   change_consumers — the persisted cursor of each journal consumer
--     (generalises plugin_event_cursors): the pg_snapshot of its last
--     complete read, the target snapshot + key of a read in progress, and
--     the single-instance claim (#1255 reuses it for "workers once per
--     site"). A plugin's consumers cascade with its row and are dropped
--     on deactivation, so a dead consumer never holds anything back.
--
-- Wake-up: the trigger NOTIFYs caelo_entity_changes (empty payload, so one
-- notification per transaction). It is only a wake-up; the cursor is the
-- truth.
--
-- Expand/contract (#696): this release stops WRITING site_view_generation
-- and font_usage_changes (their triggers are dropped here) and
-- domain_events (the ops no longer insert). The tables stay for the
-- previous release's readers during the roll; 0442 drops them in the next
-- release, marked caelo:requires-earlier-run.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE entity_changes (
  xid                   xid8 NOT NULL,
  table_name            text NOT NULL,
  row_id                text NOT NULL,
  kind                  text NOT NULL,
  op                    text NOT NULL CHECK (op IN ('insert', 'update', 'delete', 'truncate')),
  -- NULL = every column (an insert, a delete, a truncate, or a merge with
  -- one of those inside the same transaction).
  changed_columns       text[] NULL,
  parent_id             text NULL,
  plugin_id             uuid NULL,
  chat_branch_id        uuid NULL,
  owner_chat_session_id uuid NULL,
  site_snapshot_id      uuid NULL,
  prev_snapshot_id      uuid NULL,
  op_name               text NULL,
  created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (xid, table_name, row_id)
);
-- GC walks by age; readers walk the PK from a cursor's xmin.
CREATE INDEX entity_changes_created_at_idx ON entity_changes (created_at);

ALTER TABLE entity_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_changes FORCE ROW LEVEL SECURITY;
-- Every writer of a journaled table writes its rows, whatever actor it acts
-- for — including a session with no actor (a migration, a fixture): a
-- policy that refused such a session would make the write fail, and one
-- that filtered it would silently drop the change.
CREATE POLICY entity_changes_write ON entity_changes FOR INSERT WITH CHECK (true);
-- A transaction merges a second statement into its OWN row only. The
-- system GC row-locks the rows it deletes (FOR UPDATE SKIP LOCKED, so
-- concurrent passes never wait on each other), which needs the UPDATE
-- policy's USING; it never changes a row (WITH CHECK stays own-xid).
CREATE POLICY entity_changes_merge ON entity_changes FOR UPDATE
  USING (
    xid = pg_current_xact_id()
    OR current_setting('caelo.actor_kind', true) = 'system'
  )
  WITH CHECK (xid = pg_current_xact_id());
-- Every authenticated session reads it: a cached read proves itself
-- current under the reader's own identity (the editor's preview checks its
-- site view as the human or AI it renders for), and that proof must see
-- every committed change that could alter what it read — on any branch,
-- because a lock takeover moves a branch's pending state to a branch the
-- reader may not see. A row is metadata only (ids, kinds, column names, op
-- names), never content. Plugin consumers never query it: the host reads
-- for them (as system) and filters their kinds by grant. The
-- own-transaction clause lets the merge above see its row.
CREATE POLICY entity_changes_read ON entity_changes FOR SELECT
  USING (
    NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL
    OR xid = pg_current_xact_id()
  );
CREATE POLICY entity_changes_gc ON entity_changes FOR DELETE
  USING (current_setting('caelo.actor_kind', true) = 'system');

CREATE TABLE entity_change_horizons (
  -- The GC transaction's own xid: concurrent passes insert different keys.
  gc_xid     xid8 PRIMARY KEY,
  horizon    xid8 NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX entity_change_horizons_horizon_idx ON entity_change_horizons (horizon DESC);
ALTER TABLE entity_change_horizons ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_change_horizons FORCE ROW LEVEL SECURITY;
-- Every reader checks the horizon, whatever actor it acts for; it holds
-- transaction ids only. Only the system GC writes it.
CREATE POLICY entity_change_horizons_read ON entity_change_horizons FOR SELECT USING (true);
CREATE POLICY entity_change_horizons_gc ON entity_change_horizons
  USING (current_setting('caelo.actor_kind', true) = 'system')
  WITH CHECK (current_setting('caelo.actor_kind', true) = 'system');

CREATE TABLE change_consumers (
  name             text PRIMARY KEY CHECK (name ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  plugin_id        uuid NULL REFERENCES plugins(id) ON DELETE CASCADE,
  -- Every journal row visible in this snapshot was delivered.
  cursor_snapshot  pg_snapshot NOT NULL,
  -- The consumer's derived state is not built yet (it was just created, or
  -- its cursor fell behind the horizon). Set together with a cursor taken
  -- BEFORE the rebuild runs, cleared only after the rebuild succeeded: a
  -- change committed during the rebuild is delivered after it, and a failed
  -- rebuild is retried on the next run.
  rebuild_pending  boolean NOT NULL DEFAULT true,
  -- A read in progress: rows visible in page_target and not in the cursor,
  -- delivered up to (page_after_xid, page_after_table, page_after_row).
  page_target      pg_snapshot NULL,
  page_after_xid   xid8 NULL,
  page_after_table text NULL,
  page_after_row   text NULL,
  claimed_by       text NULL,
  claim_expires_at timestamptz NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((page_target IS NULL) = (page_after_xid IS NULL))
);
CREATE INDEX change_consumers_plugin_idx ON change_consumers (plugin_id) WHERE plugin_id IS NOT NULL;
ALTER TABLE change_consumers ENABLE ROW LEVEL SECURITY;
ALTER TABLE change_consumers FORCE ROW LEVEL SECURITY;
CREATE POLICY change_consumers_scope ON change_consumers
  USING (
    current_setting('caelo.actor_kind', true) = 'system'
    OR (plugin_id IS NOT NULL AND current_setting('caelo.plugin_id', true) = plugin_id::text)
  )
  WITH CHECK (
    current_setting('caelo.actor_kind', true) = 'system'
    OR (plugin_id IS NOT NULL AND current_setting('caelo.plugin_id', true) = plugin_id::text)
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON entity_changes, entity_change_horizons, change_consumers
  TO admin_role;

/**
 * The generic journal trigger (statement level, transition tables).
 * Arguments, as caelo_journal_attach passes them:
 *   0 kind, 1 key column, 2 mode (row | snapshot | header),
 *   3 comma-separated pair columns (an UPDATE's old/new rows join on them),
 *   4 parent column, 5 branch column (row mode), 6 plugin column,
 *   7 constant plugin id (plugin storage tables).
 */
CREATE FUNCTION caelo_journal_rows() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  a_kind       text := TG_ARGV[0];
  a_key        text := TG_ARGV[1];
  a_mode       text := TG_ARGV[2];
  a_pair       text[] := string_to_array(TG_ARGV[3], ',');
  a_parent     text := NULLIF(TG_ARGV[4], '');
  a_branch     text := NULLIF(TG_ARGV[5], '');
  a_plugin_col text := NULLIF(TG_ARGV[6], '');
  a_plugin_id  text := NULLIF(TG_ARGV[7], '');
  v_table      text := CASE WHEN TG_TABLE_SCHEMA = 'public' THEN TG_TABLE_NAME
                            ELSE TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME END;
  v_rel        text := format('%I.%I', TG_TABLE_SCHEMA, TG_TABLE_NAME);
  v_op         text := lower(TG_OP);
  v_from       text;
  v_changed    text;
  v_parent     text;
  v_plugin     text;
  v_branch     text;
  v_task       text;
  v_snap       text;
  v_prev       text := 'NULL::uuid';
  v_join       text := '';
  v_ident      text;
  v_lookup     text;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    INSERT INTO entity_changes (xid, table_name, row_id, kind, op, plugin_id, op_name)
    VALUES (pg_current_xact_id(), v_table, '*', a_kind, 'truncate', a_plugin_id::uuid,
            NULLIF(current_setting('caelo.op_name', true), ''))
    ON CONFLICT (xid, table_name, row_id) DO UPDATE SET op = 'truncate', changed_columns = NULL;
    PERFORM pg_notify('caelo_entity_changes', '');
    RETURN NULL;
  END IF;

  -- A statement that touched no row (an UPDATE or DELETE whose WHERE
  -- matched nothing) changed nothing: skip planning the dynamic insert,
  -- the most expensive part of the trigger, and the wake-up.
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM old_rows) THEN RETURN NULL; END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM new_rows) THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    v_from := format(
      'new_rows r LEFT JOIN old_rows o ON (%s) = (%s)',
      (SELECT string_agg(format('r.%I', c), ', ') FROM unnest(a_pair) c),
      (SELECT string_agg(format('o.%I', c), ', ') FROM unnest(a_pair) c));
    -- The columns whose value differs; an unpaired row (its key changed)
    -- counts as every column.
    v_changed := 'CASE WHEN o IS NULL THEN NULL ELSE ARRAY(
        SELECT e.key FROM jsonb_each(to_jsonb(r)) e
         WHERE e.value IS DISTINCT FROM (to_jsonb(o) -> e.key) ORDER BY e.key) END';
  ELSIF TG_OP = 'INSERT' THEN
    v_from := 'new_rows r';
    v_changed := 'NULL::text[]';
  ELSE
    v_from := 'old_rows r';
    v_changed := 'NULL::text[]';
  END IF;

  v_parent := CASE WHEN a_parent IS NULL THEN 'NULL::text' ELSE format('r.%I::text', a_parent) END;
  v_plugin := CASE WHEN a_plugin_col IS NOT NULL THEN format('r.%I', a_plugin_col)
                   WHEN a_plugin_id IS NOT NULL THEN format('%L::uuid', a_plugin_id)
                   ELSE 'NULL::uuid' END;

  IF a_mode = 'header' THEN
    v_branch := 'r.chat_branch_id';
    v_task := 'r.chat_task_id';
    v_snap := 'r.id';
  ELSIF a_mode = 'snapshot' THEN
    v_join := ' LEFT JOIN site_snapshots h ON h.id = r.site_snapshot_id';
    v_branch := 'h.chat_branch_id';
    v_task := 'h.chat_task_id';
    v_snap := 'r.site_snapshot_id';
    IF TG_OP = 'INSERT' THEN
      -- The snapshot this one replaces: the newest earlier snapshot of the
      -- same entity pending on the same branch, else the newest of the main
      -- line (a live snapshot, or a branch snapshot a Stage landed), not
      -- undone. A first draft edit thus diffs against what main shows.
      -- Each lookup walks the entity's (key, created_at DESC) index from the
      -- newest snapshot down and stops at the first match: O(log k) for an
      -- entity with k snapshots, not O(k). COALESCE runs the second lookup
      -- only when the first found nothing.
      v_ident := format('p.%I = r.%I', a_key, a_key)
        || CASE WHEN a_parent IS NULL THEN '' ELSE format(' AND p.%I = r.%I', a_parent, a_parent) END
        || CASE WHEN a_plugin_col IS NULL THEN '' ELSE format(' AND p.%I = r.%I', a_plugin_col, a_plugin_col) END;
      v_lookup := format(
        '(SELECT p.site_snapshot_id FROM %s p JOIN site_snapshots ph ON ph.id = p.site_snapshot_id
           WHERE %s AND p.id <> r.id AND ph.undone_at IS NULL
             AND (p.created_at, ph.created_at) < (r.created_at, h.created_at)
             AND %%s
           ORDER BY p.created_at DESC LIMIT 1)',
        v_rel, v_ident);
      v_prev := format('COALESCE(CASE WHEN h.chat_branch_id IS NULL THEN NULL ELSE %s END, %s)',
        format(v_lookup, 'ph.chat_branch_id = h.chat_branch_id AND ph.staged_at IS NULL'),
        format(v_lookup, '(ph.chat_branch_id IS NULL OR ph.staged_at IS NOT NULL)'));
    END IF;
  ELSE
    v_branch := CASE WHEN a_branch IS NULL THEN 'NULL::uuid' ELSE format('r.%I', a_branch) END;
    v_task := 'NULLIF(current_setting(''caelo.chat_task_id'', true), '''')::uuid';
    v_snap := 'NULL::uuid';
  END IF;

  EXECUTE format($q$
    WITH src AS (
      SELECT r.%1$I::text AS row_id, %2$s AS parent_id, %3$s AS plugin_id,
             %4$s AS branch, %5$s AS task, %6$s AS snap, %7$s AS prev, %8$s AS changed
        FROM %9$s %10$s
    ),
    kept AS (
      -- An UPDATE that changed nothing, or only updated_at, is no change.
      SELECT * FROM src
       WHERE changed IS NULL OR NOT (changed <@ ARRAY['updated_at']::text[])
    ),
    cols AS (
      -- Several rows of one entity (page_terms of a page) merge: the union
      -- of their changed columns, or every column when one of them says so.
      SELECT k.row_id,
             CASE WHEN bool_or(k.changed IS NULL) THEN NULL
                  ELSE COALESCE(array_agg(DISTINCT u.col ORDER BY u.col)
                                  FILTER (WHERE u.col IS NOT NULL), '{}'::text[]) END AS changed
        FROM kept k LEFT JOIN LATERAL unnest(k.changed) AS u(col) ON true
       GROUP BY k.row_id
    ),
    agg AS (
      SELECT DISTINCT ON (row_id) row_id, parent_id, plugin_id, branch, task, snap, prev
        FROM kept ORDER BY row_id, snap NULLS LAST
    )
    INSERT INTO entity_changes AS ec
      (xid, table_name, row_id, kind, op, changed_columns, parent_id, plugin_id,
       chat_branch_id, owner_chat_session_id, site_snapshot_id, prev_snapshot_id, op_name)
    SELECT pg_current_xact_id(), %11$L, agg.row_id, %12$L, %13$L, cols.changed,
           agg.parent_id, agg.plugin_id, agg.branch,
           CASE WHEN agg.task IS NULL THEN NULL ELSE caelo_chat_owner(agg.task) END,
           agg.snap, agg.prev, NULLIF(current_setting('caelo.op_name', true), '')
      FROM agg JOIN cols USING (row_id)
    -- Merging statements of one transaction: a truncate or delete wins;
    -- otherwise the FIRST statement's op stays — an entity created in this
    -- transaction stays an insert, and an existing row a later statement
    -- touched again (a lock takeover followed by the taker's own write)
    -- stays an update, so a reader of the branch it left sees the change.
    ON CONFLICT (xid, table_name, row_id) DO UPDATE SET
      op = CASE WHEN 'truncate' IN (ec.op, EXCLUDED.op) THEN 'truncate'
                WHEN 'delete' IN (ec.op, EXCLUDED.op) THEN 'delete'
                ELSE ec.op END,
      changed_columns = CASE WHEN ec.changed_columns IS NULL OR EXCLUDED.changed_columns IS NULL
                             THEN NULL
                             ELSE ARRAY(SELECT DISTINCT c FROM unnest(ec.changed_columns || EXCLUDED.changed_columns) c ORDER BY c)
                        END,
      site_snapshot_id = COALESCE(EXCLUDED.site_snapshot_id, ec.site_snapshot_id),
      prev_snapshot_id = COALESCE(ec.prev_snapshot_id, EXCLUDED.prev_snapshot_id),
      chat_branch_id = COALESCE(EXCLUDED.chat_branch_id, ec.chat_branch_id),
      owner_chat_session_id = COALESCE(EXCLUDED.owner_chat_session_id, ec.owner_chat_session_id),
      op_name = COALESCE(ec.op_name, EXCLUDED.op_name)
  $q$,
    a_key, v_parent, v_plugin, v_branch, v_task, v_snap, v_prev, v_changed, v_from, v_join,
    v_table, a_kind, v_op);

  PERFORM pg_notify('caelo_entity_changes', '');
  RETURN NULL;
END
$fn$;

/**
 * Attach the journal trigger to one table (idempotent: CREATE OR REPLACE).
 * One trigger per event, because a trigger with transition tables may
 * name only one event.
 */
CREATE FUNCTION caelo_journal_attach(
  tbl regclass, kind text, key_col text, mode text, pair_cols text,
  parent_col text DEFAULT '', branch_col text DEFAULT '', plugin_col text DEFAULT '',
  plugin_id text DEFAULT ''
) RETURNS void
LANGUAGE plpgsql
AS $fn$
DECLARE
  args text := format('%L, %L, %L, %L, %L, %L, %L, %L',
                      kind, key_col, mode, pair_cols, parent_col, branch_col, plugin_col, plugin_id);
BEGIN
  IF mode NOT IN ('row', 'snapshot', 'header') THEN
    RAISE EXCEPTION 'caelo_journal_attach(%): unknown mode %', tbl, mode;
  END IF;
  EXECUTE format('CREATE OR REPLACE TRIGGER caelo_journal_insert AFTER INSERT ON %s
                    REFERENCING NEW TABLE AS new_rows
                    FOR EACH STATEMENT EXECUTE FUNCTION caelo_journal_rows(%s)', tbl, args);
  EXECUTE format('CREATE OR REPLACE TRIGGER caelo_journal_update AFTER UPDATE ON %s
                    REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
                    FOR EACH STATEMENT EXECUTE FUNCTION caelo_journal_rows(%s)', tbl, args);
  EXECUTE format('CREATE OR REPLACE TRIGGER caelo_journal_delete AFTER DELETE ON %s
                    REFERENCING OLD TABLE AS old_rows
                    FOR EACH STATEMENT EXECUTE FUNCTION caelo_journal_rows(%s)', tbl, args);
  EXECUTE format('CREATE OR REPLACE TRIGGER caelo_journal_truncate AFTER TRUNCATE ON %s
                    FOR EACH STATEMENT EXECUTE FUNCTION caelo_journal_rows(%s)', tbl, args);
END
$fn$;

-- What the journal's prev_snapshot_id lookup walks (newest first, per
-- entity). Every snapshot table carries created_at (the writing
-- transaction's time).
CREATE INDEX page_snapshots_entity_time_idx ON page_snapshots (page_id, created_at DESC);
CREATE INDEX page_layout_snapshots_entity_time_idx ON page_layout_snapshots (page_id, created_at DESC);
CREATE INDEX page_module_content_snapshots_entity_time_idx
  ON page_module_content_snapshots (page_module_content_id, page_id, created_at DESC);
CREATE INDEX module_snapshots_entity_time_idx ON module_snapshots (module_id, created_at DESC);
CREATE INDEX template_snapshots_entity_time_idx ON template_snapshots (template_id, created_at DESC);
CREATE INDEX layout_module_snapshots_entity_time_idx ON layout_module_snapshots (layout_id, created_at DESC);
CREATE INDEX content_instance_snapshots_entity_time_idx
  ON content_instance_snapshots (content_instance_id, created_at DESC);
CREATE INDEX list_snapshots_entity_time_idx ON list_snapshots (list_id, created_at DESC);
CREATE INDEX list_type_snapshots_entity_time_idx ON list_type_snapshots (list_type_id, created_at DESC);
CREATE INDEX page_type_snapshots_entity_time_idx ON page_type_snapshots (page_type_id, created_at DESC);
CREATE INDEX theme_snapshots_entity_time_idx ON theme_snapshots (theme_id, created_at DESC);
CREATE INDEX plugin_row_snapshots_entity_time_idx
  ON plugin_row_snapshots (row_id, table_name, plugin_id, created_at DESC);

-- The registered table set (packages/shared/src/change-journal.ts).
SELECT caelo_journal_attach('pages', 'page', 'id', 'row', 'id', '', 'chat_branch_id');
SELECT caelo_journal_attach('page_terms', 'page_terms', 'page_id', 'row', 'page_id,list_id,item_id');
SELECT caelo_journal_attach('pages_seo', 'page_seo', 'page_id', 'row', 'page_id');
SELECT caelo_journal_attach('page_modules', 'page_layout', 'page_id', 'row', 'page_id,block_name,position');
SELECT caelo_journal_attach('page_module_content', 'page_module_content', 'id', 'row', 'id', 'page_id');
SELECT caelo_journal_attach('modules', 'module', 'id', 'row', 'id', '', 'chat_branch_id');
SELECT caelo_journal_attach('templates', 'template', 'id', 'row', 'id', '', 'chat_branch_id');
SELECT caelo_journal_attach('template_blocks', 'template_blocks', 'template_id', 'row', 'template_id,name');
SELECT caelo_journal_attach('layouts', 'layout', 'id', 'row', 'id', '', 'chat_branch_id');
SELECT caelo_journal_attach('layout_blocks', 'layout_blocks', 'layout_id', 'row', 'layout_id,name');
SELECT caelo_journal_attach('layout_modules', 'layout_module', 'layout_id', 'row', 'layout_id,block_name,position');
SELECT caelo_journal_attach('content_instances', 'content_instance', 'id', 'row', 'id', 'module_id', 'chat_branch_id');
SELECT caelo_journal_attach('lists', 'list', 'id', 'row', 'id', '', 'chat_branch_id');
SELECT caelo_journal_attach('list_types', 'list_type', 'id', 'row', 'id', '', 'chat_branch_id');
SELECT caelo_journal_attach('page_types', 'page_type', 'id', 'row', 'id', '', 'chat_branch_id');
SELECT caelo_journal_attach('themes', 'theme', 'id', 'row', 'id');
SELECT caelo_journal_attach('media_assets', 'media', 'id', 'row', 'id');
SELECT caelo_journal_attach('media_variants', 'media_variant', 'asset_id', 'row', 'asset_id,variant');
SELECT caelo_journal_attach('media_crops', 'media_crop', 'id', 'row', 'id', 'asset_id');
SELECT caelo_journal_attach('font_assets', 'font', 'id', 'row', 'id');
SELECT caelo_journal_attach('redirects', 'redirect', 'id', 'row', 'id');
SELECT caelo_journal_attach('domains', 'domain', 'id', 'row', 'id');
SELECT caelo_journal_attach('site_defaults', 'site_defaults', 'id', 'row', 'id');
SELECT caelo_journal_attach('site_settings', 'site_settings', 'id', 'row', 'id');
SELECT caelo_journal_attach('site_ai_memory', 'site_memory', 'id', 'row', 'id');
SELECT caelo_journal_attach('skills', 'skill', 'id', 'row', 'id');
SELECT caelo_journal_attach('plugins', 'plugin', 'id', 'row', 'id');
SELECT caelo_journal_attach('plugin_installation_versions', 'plugin_installation', 'id', 'row', 'id', 'plugin_id');
SELECT caelo_journal_attach('plugin_capability_grants', 'plugin_grant', 'id', 'row', 'id', 'plugin_id');
SELECT caelo_journal_attach('plugin_private_files', 'plugin_file', 'id', 'row', 'plugin_id,id', '', '', 'plugin_id');

SELECT caelo_journal_attach('site_snapshots', 'snapshot', 'id', 'header', 'id');
SELECT caelo_journal_attach('page_snapshots', 'page', 'page_id', 'snapshot', 'id');
SELECT caelo_journal_attach('page_layout_snapshots', 'page_layout', 'page_id', 'snapshot', 'id');
SELECT caelo_journal_attach('page_module_content_snapshots', 'page_module_content', 'page_module_content_id', 'snapshot', 'id', 'page_id');
SELECT caelo_journal_attach('module_snapshots', 'module', 'module_id', 'snapshot', 'id');
SELECT caelo_journal_attach('template_snapshots', 'template', 'template_id', 'snapshot', 'id');
SELECT caelo_journal_attach('layout_module_snapshots', 'layout_module', 'layout_id', 'snapshot', 'id');
SELECT caelo_journal_attach('content_instance_snapshots', 'content_instance', 'content_instance_id', 'snapshot', 'id');
SELECT caelo_journal_attach('list_snapshots', 'list', 'list_id', 'snapshot', 'id');
SELECT caelo_journal_attach('list_type_snapshots', 'list_type', 'list_type_id', 'snapshot', 'id');
SELECT caelo_journal_attach('page_type_snapshots', 'page_type', 'page_type_id', 'snapshot', 'id');
SELECT caelo_journal_attach('theme_snapshots', 'theme', 'theme_id', 'snapshot', 'id');
SELECT caelo_journal_attach('plugin_row_snapshots', 'plugin_row', 'row_id', 'snapshot', 'id', 'table_name', '', 'plugin_id');

/**
 * Journal every table of a plugin's own cms_admin schema under the kind
 * `plugin_storage`, keyed on the plugin's id (never its reusable slug).
 * The host calls it whenever it provisions the schema, so a new plugin or
 * a new plugin table needs no journal migration.
 */
CREATE FUNCTION caelo_journal_attach_plugin_schema(schema_name text, plugin uuid) RETURNS int
LANGUAGE plpgsql
AS $fn$
DECLARE
  t record;
  n int := 0;
BEGIN
  IF schema_name !~ '^plugin_[a-z][a-z0-9_]*$' THEN
    RAISE EXCEPTION 'caelo_journal_attach_plugin_schema: % is not a plugin schema', schema_name;
  END IF;
  FOR t IN
    SELECT c.oid::regclass AS rel FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = schema_name AND c.relkind = 'r'
  LOOP
    -- caelo_chat_branch_id is the host column a branch-created row carries.
    PERFORM caelo_journal_attach(t.rel, 'plugin_storage', 'id', 'row', 'id', '',
                                 'caelo_chat_branch_id', '', plugin::text);
    n := n + 1;
  END LOOP;
  RETURN n;
END
$fn$;

-- Backfill: the plugin schemas provisioned before this migration.
SELECT caelo_journal_attach_plugin_schema('plugin_' || replace(p.slug, '-', '_'), p.id)
  FROM plugins p
 WHERE to_regnamespace('plugin_' || replace(p.slug, '-', '_')) IS NOT NULL;

-- A plugin that stops being active loses its consumers (rule 4): its
-- cursor holds nothing back, and a later activation starts from a rebuild.
-- Any writer may delete them, because the writer of the status flip may be
-- a human (the Owner's Disable click) whom change_consumers' scope does not
-- otherwise admit; deleting the cursor of a plugin that is not active is
-- harmless by construction.
CREATE POLICY change_consumers_drop_inactive ON change_consumers FOR DELETE
  USING (
    plugin_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM plugins p WHERE p.id = plugin_id AND p.status = 'active')
  );

CREATE FUNCTION caelo_drop_inactive_plugin_consumers() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  DELETE FROM change_consumers WHERE plugin_id = NEW.id;
  RETURN NULL;
END
$fn$;

CREATE TRIGGER caelo_drop_inactive_plugin_consumers
  AFTER UPDATE OF status ON plugins FOR EACH ROW
  WHEN (OLD.status = 'active' AND NEW.status <> 'active')
  EXECUTE FUNCTION caelo_drop_inactive_plugin_consumers();

-- Outbox work still outstanding at the upgrade (events past the plugin's
-- plugin_event_cursors position, e.g. inside its polling interval) predates
-- the journal, so the journal cursor seeded below cannot replay it. Of the
-- retired outbox's only consumer, international-site, the work that is not
-- recomputed from stored state is page staleness: a live `page.updated` or
-- `page.published` of a SOURCE page marks its up-to-date siblings
-- needs_update, exactly as its last outbox tick did. Done before the cursor
-- is accepted, so the source-hash backfill (the plugin's onActivate, which
-- also re-derives chrome and list statuses from their stored hashes) never
-- adopts an edited source as a translation's baseline.
-- A function (dropped with the outbox tables by 0442) so the step is
-- tested on its own.
CREATE FUNCTION caelo_intl_reconcile_retired_outbox() RETURNS int
LANGUAGE plpgsql
AS $fn$
DECLARE
  intl uuid;
  marked int;
BEGIN
  SELECT p.id INTO intl FROM plugins p
   WHERE p.slug = 'international-site' AND p.status = 'active';
  IF intl IS NULL OR to_regclass('plugin_international_site.page_variants') IS NULL THEN
    RETURN 0;
  END IF;
  -- The plugin's rows are RLS-scoped to its id (FORCE'd for owners too).
  PERFORM set_config('caelo.plugin_id', intl::text, true);
  UPDATE plugin_international_site.page_variants sib
     SET translation_status = 'needs_update', caelo_updated_at = now()
    FROM plugin_international_site.page_variants src
   WHERE src.translation_status = 'source'
     AND src.caelo_chat_branch_id IS NULL AND src.caelo_deleted_at IS NULL
     AND sib.group_id = src.group_id AND sib.id <> src.id
     AND sib.translation_status = 'up_to_date'
     AND sib.caelo_chat_branch_id IS NULL AND sib.caelo_deleted_at IS NULL
     AND EXISTS (
       SELECT 1 FROM domain_events ev
        WHERE ev.entity_id = src.page_id
          AND ev.kind IN ('page.updated', 'page.published')
          AND COALESCE(ev.payload ->> 'chatBranchId', '') = ''
          AND ev.id > COALESCE(
                (SELECT c.cursor_id FROM plugin_event_cursors c WHERE c.plugin_id = intl), 0));
  GET DIAGNOSTICS marked = ROW_COUNT;
  PERFORM set_config('caelo.plugin_id', '', true);
  RETURN marked;
END
$fn$;
SELECT caelo_intl_reconcile_retired_outbox();

-- The plugins that consumed the retired outbox keep reading from here on:
-- their journal cursor starts now, so no rebuild runs after the upgrade.
-- (A cursor created later, on a first activation, runs the plugin's rebuild.)
INSERT INTO change_consumers (name, plugin_id, cursor_snapshot, rebuild_pending)
SELECT 'plugin:' || p.id::text, p.id, pg_current_snapshot(), false
  FROM plugins p
 WHERE p.status = 'active'
   AND (p.manifest_json -> 'requestedCapabilities') ? 'domain_events'
ON CONFLICT (name) DO NOTHING;

-- Stop writing the retired change signals (the tables stay until 0442).
DO $do$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'pages', 'page_terms', 'pages_seo', 'media_assets', 'site_defaults',
    'list_types', 'lists', 'page_types',
    'list_type_snapshots', 'list_snapshots', 'page_type_snapshots',
    'site_snapshots', 'page_snapshots',
    'plugins', 'plugin_installation_versions', 'plugin_capability_grants'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS caelo_site_view_generation ON %I', t);
    EXECUTE format('DROP TRIGGER IF EXISTS caelo_site_view_generation_truncate ON %I', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY[
    'modules', 'templates', 'layouts', 'content_instances', 'page_module_content', 'plugins'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS caelo_font_usage_change ON %I', t);
  END LOOP;
END
$do$;

COMMIT;
