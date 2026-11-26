-- SPDX-License-Identifier: MPL-2.0
--
-- 0885 — the change journal's and the draft head's triggers cost a
-- database connection a few kilobytes per table instead of a quarter of a
-- megabyte (issue #1749).
--
-- PL/pgSQL compiles a trigger function once per TRIGGER, not once per
-- function, and every connection keeps each copy, with a cached plan for
-- every expression the copy ran, until the connection closes. The journal
-- trigger (0430) is attached four times to every journaled table: 276
-- triggers on 69 tables on searchVIU. One copy of its body takes 128 kB,
-- and each of its seventeen expressions a cached plan of about 10 kB (a
-- `NULL` costs as much as a `format(...)`): a copy that ran its whole path
-- cost a connection about 400 kB, so a connection that had written to
-- every journaled table held tens of megabytes for the journal alone.
-- Every cms_admin connection gets there: the pools hand each connection
-- every kind of write in turn, and keep it for hours.
--
-- Measured (packages/migrations/src/trigger-memory.integration.test.ts
-- keeps it there): a journal copy 412 kB before, 66 kB after; every
-- trigger of a migrated cms_admin fired once, 137 kB per trigger before,
-- 41 kB after; one connection after all of them, 52.8 MB before, 21.1 MB
-- after.
--
-- On 2026-11-26 two admin instances held 22 such connections on a
-- db-f1-micro (614 MB). The server swapped 400 to 890 MB, read up to
-- 100,000 pages a minute back from swap, and every statement waited for
-- its memory: a primary-key read, `set_config`, the provider's own probes
-- ran into the 60 s statement timeout while the CPU idled at 0.2.
--
-- Now each trigger body is the few lines that must see the transition
-- tables; the statements they run are built by ordinary functions, which
-- PL/pgSQL compiles once per connection whatever the number of tables:
--
-- - caelo_journal_rows skips a statement that touched no row, else runs
--   what caelo_journal_statement builds: the statement 0430 built,
--   character for character, plus `RETURNING 1` and the NOTIFY. The
--   wake-up is now sent only when the statement journaled a row (it is
--   only a wake-up; an UPDATE that changed nothing but updated_at
--   journals nothing, and woke the consumers for nothing).
-- - caelo_draft_head_rows (0860) runs the read caelo_draft_head_changed_sql
--   builds for an UPDATE or DELETE, the same text as before, and reads its
--   arguments where it uses them instead of copying them into variables.
--
-- Same triggers, same arguments, same rows: the registry test and every
-- journal and draft-head test hold. Expand-only (#696): the previous image
-- runs against the same triggers.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

/**
 * The statement that journals one trigger firing: what 0430's trigger built
 * inline. `p_op` is TG_OP; the rest are the trigger's table and its
 * arguments as caelo_journal_attach passes them (kind, key column, mode,
 * pair columns, parent column, branch column, plugin column, constant
 * plugin id). The statement reads the trigger's transition tables, so only
 * the trigger itself can run it.
 */
CREATE OR REPLACE FUNCTION caelo_journal_statement(
  p_op text, p_schema text, p_table text,
  a_kind text, a_key text, a_mode text, p_pair text,
  p_parent text, p_branch text, p_plugin_col text, p_plugin_id text
) RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE
  a_pair       text[] := string_to_array(p_pair, ',');
  a_parent     text := NULLIF(p_parent, '');
  a_branch     text := NULLIF(p_branch, '');
  a_plugin_col text := NULLIF(p_plugin_col, '');
  a_plugin_id  text := NULLIF(p_plugin_id, '');
  v_table      text := CASE WHEN p_schema = 'public' THEN p_table
                            ELSE p_schema || '.' || p_table END;
  v_rel        text := format('%I.%I', p_schema, p_table);
  v_op         text := lower(p_op);
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
  IF p_op = 'TRUNCATE' THEN
    RETURN format($q$
      WITH ins AS (
        INSERT INTO entity_changes (xid, table_name, row_id, kind, op, plugin_id, op_name)
        VALUES (pg_current_xact_id(), %1$L, '*', %2$L, 'truncate', %3$L::uuid,
                NULLIF(current_setting('caelo.op_name', true), ''))
        ON CONFLICT (xid, table_name, row_id) DO UPDATE SET op = 'truncate', changed_columns = NULL
        RETURNING 1
      )
      SELECT pg_notify('caelo_entity_changes', '') FROM ins
    $q$, v_table, a_kind, a_plugin_id);
  END IF;

  IF p_op = 'UPDATE' THEN
    v_from := format(
      'new_rows r LEFT JOIN old_rows o ON (%s) = (%s)',
      (SELECT string_agg(format('r.%I', c), ', ') FROM unnest(a_pair) c),
      (SELECT string_agg(format('o.%I', c), ', ') FROM unnest(a_pair) c));
    -- The columns whose value differs; an unpaired row (its key changed)
    -- counts as every column.
    v_changed := 'CASE WHEN o IS NULL THEN NULL ELSE ARRAY(
        SELECT e.key FROM jsonb_each(to_jsonb(r)) e
         WHERE e.value IS DISTINCT FROM (to_jsonb(o) -> e.key) ORDER BY e.key) END';
  ELSIF p_op = 'INSERT' THEN
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
    IF p_op = 'INSERT' THEN
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

  RETURN format($q$
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
    ),
    ins AS (
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
      RETURNING 1
    )
    -- The wake-up (an empty payload, so one notification per transaction),
    -- only when the statement journaled a row.
    SELECT pg_notify('caelo_entity_changes', '') FROM (SELECT 1 FROM ins LIMIT 1) journaled
  $q$,
    a_key, v_parent, v_plugin, v_branch, v_task, v_snap, v_prev, v_changed, v_from, v_join,
    v_table, a_kind, v_op);
END
$fn$;

/**
 * The generic journal trigger (statement level, transition tables),
 * attached by caelo_journal_attach. Arguments: see caelo_journal_statement.
 *
 * Keep this body small: PL/pgSQL compiles it once per trigger and every
 * connection keeps each copy (see the header). Logic that does not need
 * the transition tables belongs in caelo_journal_statement.
 */
CREATE OR REPLACE FUNCTION caelo_journal_rows() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  -- A statement that touched no row (an UPDATE or DELETE whose WHERE
  -- matched nothing) changed nothing: skip building and planning the
  -- dynamic insert, the most expensive part of the trigger. Each check
  -- names one transition table only: an expression is planned whole, and
  -- a trigger has only the transition tables of its own event.
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    IF NOT EXISTS (SELECT 1 FROM new_rows) THEN RETURN NULL; END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM old_rows) THEN RETURN NULL; END IF;
  END IF;
  EXECUTE caelo_journal_statement(TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME,
    TG_ARGV[0], TG_ARGV[1], TG_ARGV[2], TG_ARGV[3], TG_ARGV[4], TG_ARGV[5], TG_ARGV[6], TG_ARGV[7]);
  RETURN NULL;
END
$fn$;

/**
 * The read that names the head rows an UPDATE or DELETE of a snapshot
 * table must recompute (0860's caelo_draft_head_rows built it inline):
 * every head row of a changed row's entity on any branch, plus, for an
 * UPDATE, wherever a changed row now sits under a pending branch header
 * (its new key — a takeover). It returns the branches, entities and
 * sub-keys as three arrays, and reads the trigger's transition tables.
 * PL/pgSQL, not SQL: a SQL function would be inlined into the calling
 * expression, and so into every trigger copy's cached plan.
 */
CREATE OR REPLACE FUNCTION caelo_draft_head_changed_sql(p_op text, a_kind text, a_key text, a_sub text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
BEGIN
  RETURN format($q$
    SELECT array_agg(k.b), array_agg(k.e), array_agg(k.s) FROM (
      SELECT d.chat_branch_id AS b, d.entity_id AS e, d.entity_sub AS s
        FROM draft_pending_entities d
       WHERE d.entity_kind = %1$L
         AND (d.entity_id, d.entity_sub) IN (SELECT o.%2$I, %3$s FROM old_rows o)
      %4$s
    ) k
  $q$, a_kind, a_key, caelo_draft_head_sub(a_sub, 'o'),
    CASE WHEN p_op = 'UPDATE' THEN format($u$
      UNION
      SELECT h.chat_branch_id, n.%1$I, %2$s
        FROM new_rows n JOIN site_snapshots h ON h.id = n.site_snapshot_id
       WHERE h.chat_branch_id IS NOT NULL AND h.staged_at IS NULL AND h.undone_at IS NULL
    $u$, a_key, caelo_draft_head_sub(a_sub, 'n')) ELSE '' END);
END
$fn$;

/**
 * Maintainer on each snapshot table (statement level, transition tables).
 * TG_ARGV: kind, entity column, sub-key template (caelo_draft_head_tables).
 * Same behaviour as 0860; the statements are built outside the body, which
 * PL/pgSQL compiles once per trigger (see the header).
 */
CREATE OR REPLACE FUNCTION caelo_draft_head_rows() RETURNS trigger
  LANGUAGE plpgsql
  AS $fn$
DECLARE
  v_b uuid[];
  v_e uuid[];
  v_s text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- 0860: only a row under a pending branch header can enter the head.
    IF NOT EXISTS (
      SELECT 1 FROM new_rows n JOIN site_snapshots h ON h.id = n.site_snapshot_id
       WHERE h.chat_branch_id IS NOT NULL AND h.staged_at IS NULL AND h.undone_at IS NULL
    ) THEN
      RETURN NULL;
    END IF;
    EXECUTE caelo_draft_head_upsert_sql(caelo_draft_head_source(
      TG_TABLE_NAME, 'es.id IN (SELECT n.id FROM new_rows n)'));
  ELSIF TG_OP = 'TRUNCATE' THEN
    DELETE FROM draft_pending_entities WHERE entity_kind = TG_ARGV[0];
  ELSE
    EXECUTE caelo_draft_head_changed_sql(TG_OP, TG_ARGV[0], TG_ARGV[1], TG_ARGV[2])
      INTO v_b, v_e, v_s;
    PERFORM caelo_draft_head_recompute(TG_ARGV[0], v_b, v_e, v_s);
  END IF;
  RETURN NULL;
END
$fn$;

COMMIT;
