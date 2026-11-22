-- SPDX-License-Identifier: MPL-2.0
--
-- 0750 — reading the change journal assigns no transaction id (#1672).
--
-- The read policy let a session without an identity see its own
-- transaction's rows through `xid = pg_current_xact_id()`. That function
-- assigns an xid to a transaction that has none, and Postgres evaluates it
-- while planning (a stable function folded for the estimate), so every
-- statement that read `entity_changes` gave its transaction an xid: every
-- cache check, consumer poll and preview read, even an EXPLAIN.
--
-- A cached read's mark then carried that xid, and every reader running
-- beside it saw the marked transaction in flight; the follow test counted
-- it as one the mark had seen committed, so the cache looked stale to them
-- all, and the site view read the whole site again. Each such read also
-- wrote a commit record and lengthened every other snapshot's in-flight
-- list. `pg_current_xact_id_if_assigned()` means the same here (a
-- transaction without an xid has written no journal row) and assigns
-- nothing.

ALTER POLICY entity_changes_read ON entity_changes
  USING (
    NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL
    OR xid = pg_current_xact_id_if_assigned()
  );
