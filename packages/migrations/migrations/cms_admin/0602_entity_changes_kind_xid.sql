-- SPDX-License-Identifier: MPL-2.0
--
-- 0602 — the change journal by kind, then transaction (issue #1269, epic
-- #1392).
--
-- Every journal reader asks for a few kinds after a point in the journal:
-- a cached read's freshness check (`checkJournalMark`, the site view on
-- every preview render) and every consumer poll (`readChanges`). The
-- primary key leads with the transaction, so a reader walked every row
-- written since its mark and dropped the ones of other kinds. A stale mark
-- of the site view sat behind tens of thousands of plugin row snapshots
-- (a plugin rebuilding 50,000 pages), so one check read all of them: 27
-- checks at 9.5 s each in the capped scale gate. With (kind, xid) a reader
-- reads one index range per kind it asks for, and only rows of those kinds.
--
-- Text and xid8 comparisons are leakproof, so the index stays usable under
-- the table's FORCEd row level security.
--
-- Expand-only: one index. The journal holds the retention window only
-- (garbage collection), so building it is short.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE INDEX entity_changes_kind_xid_idx ON entity_changes (kind, xid);

COMMIT;
