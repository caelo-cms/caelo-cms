-- SPDX-License-Identifier: MPL-2.0
--
-- 0860 — the draft head's maintainer skips a snapshot write no branch has
-- pending.
--
-- Every insert into a snapshot table ran the head's upsert (0477): the
-- generated source query, planned on every call (EXECUTE), and the
-- statement-level maintainers of draft_pending_entities behind it
-- (content value hashes 0658, page words 0612). For a snapshot under a
-- main-line header the source has nothing to give: the head holds pending
-- branch snapshots only (`h.chat_branch_id IS NOT NULL`, not staged, not
-- undone). Main-line snapshots are what a plugin's private storage records
-- on every write outside a chat (workers, the Owner panel, a Stage's
-- page-output observer), so each such write paid about a third of its
-- database time for nothing — 2,400 times in one Stage of searchVIU
-- (2026-11-26), where the site-search observer rewrote its report rows.
--
-- The maintainer now first asks whether any inserted row sits under a
-- pending branch header (a static query, planned once per trigger), and
-- runs the upsert only then. The upsert, its source and every other path
-- are unchanged; a skipped insert is one the upsert would have left
-- without a head row, so the head stays exactly what the rebuild computes.
--
-- Expand-only (#696): the same signature and triggers; the previous image
-- reads the same head.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

/**
 * Maintainer on each snapshot table (statement level, transition tables).
 * TG_ARGV: kind, entity column, sub-key template (caelo_draft_head_tables).
 */
CREATE OR REPLACE FUNCTION caelo_draft_head_rows() RETURNS trigger
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
    -- 0860: only a row under a pending branch header can enter the head.
    IF NOT EXISTS (
      SELECT 1 FROM new_rows n JOIN site_snapshots h ON h.id = n.site_snapshot_id
       WHERE h.chat_branch_id IS NOT NULL AND h.staged_at IS NULL AND h.undone_at IS NULL
    ) THEN
      RETURN NULL;
    END IF;
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

COMMIT;
