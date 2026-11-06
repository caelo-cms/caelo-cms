-- SPDX-License-Identifier: MPL-2.0
-- caelo:no-transaction
--
-- 0650 — the change journal's counted operations, by kind and
-- transaction (issue #1269, epic #1392).
--
-- A reader may count only some operations of a kind: the site view counts
-- a snapshot header's updates and deletes (a Stage, an undo), never its
-- insert — and every write inserts one. Under 0602's (kind, xid) the
-- operation was a filter after the index, so the site view's freshness
-- check read every header a write inserted since its mark: in the capped
-- scale gate 34 checks at 8.4 s and about 13,000 buffers each while
-- plugins wrote. This partial index holds the journal's non-insert rows
-- only; a reader group that does not count inserts names the same
-- predicate (`op <> 'insert'`), so the planner reads it there, and the
-- inserts it ignores cost it nothing.
--
-- Expand-only: 0602's (kind, xid) stays, serving every reader that counts
-- inserts and the previous release, which runs while this migrates and
-- after a rollback.
--
-- Text and xid8 comparisons are leakproof, so the index is usable under
-- the table's FORCEd row level security. Built CONCURRENTLY outside a
-- transaction, as 0602: every journaled write inserts here. Dropped first:
-- an interrupted concurrent build leaves an INVALID index that
-- `IF NOT EXISTS` would keep.

DROP INDEX CONCURRENTLY IF EXISTS entity_changes_kind_xid_counted_idx;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY entity_changes_kind_xid_counted_idx ON entity_changes (kind, xid)
  WHERE op <> 'insert';
