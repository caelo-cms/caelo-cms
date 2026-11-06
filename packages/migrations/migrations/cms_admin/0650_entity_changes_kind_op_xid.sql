-- SPDX-License-Identifier: MPL-2.0
-- caelo:no-transaction
--
-- 0650 — the change journal by kind, operation, then transaction (issue
-- #1269, epic #1392). Replaces 0602's (kind, xid).
--
-- A reader may count only some operations of a kind: the site view counts
-- a snapshot header's updates and deletes (a Stage, an undo), never its
-- insert — and every write inserts one. Under (kind, xid) the operation
-- was a filter after the index, so the site view's freshness check read
-- every header a write inserted since its mark: in the capped scale gate
-- 34 checks at 8.4 s and about 13,000 buffers each while plugins wrote.
-- With the operation in the index, each reader's (kinds, operations)
-- group is one index range (`op = ANY` between the kind and the
-- transaction), so the rows a reader does not count cost it nothing.
--
-- Readers always name their operations (all four when they count every
-- one), so (kind, op, xid) serves every reader (kind, xid) served: the
-- old index goes, and the journal's writes keep one secondary index of
-- this kind.
--
-- Text and xid8 comparisons are leakproof, so the index is usable under
-- the table's FORCEd row level security. Built CONCURRENTLY outside a
-- transaction, as 0602: every journaled write inserts here. Each index is
-- dropped first: an interrupted concurrent build leaves an INVALID index
-- that `IF NOT EXISTS` would keep.

DROP INDEX CONCURRENTLY IF EXISTS entity_changes_kind_op_xid_idx;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY entity_changes_kind_op_xid_idx ON entity_changes (kind, op, xid);
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS entity_changes_kind_xid_idx;
