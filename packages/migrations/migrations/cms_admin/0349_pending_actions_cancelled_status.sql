-- SPDX-License-Identifier: MPL-2.0
--
-- 0349 — the AI can withdraw its own URL-migration and quality proposals
-- (#699).
--
-- pending_proposals.cancel sets status='cancelled' on the AI's own pending
-- row. Every unified-shape *_pending_actions table allows that value since
-- v0.2.35 except the two created later with the older four-value CHECK:
-- url_migration_pending_actions (0211) and quality_pending_actions (0238).
-- The cancel op skipped them, so a proposal the AI queued in error there
-- could only wait for the Owner's Reject or the 30-day GC.
--
-- Expand-only: the CHECK gains a value; existing rows stay valid.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE url_migration_pending_actions
  DROP CONSTRAINT IF EXISTS url_migration_pending_actions_status_check;
ALTER TABLE url_migration_pending_actions
  ADD CONSTRAINT url_migration_pending_actions_status_check
  CHECK (status IN ('pending', 'applied', 'rejected', 'superseded', 'cancelled'));

ALTER TABLE quality_pending_actions
  DROP CONSTRAINT IF EXISTS quality_pending_actions_status_check;
ALTER TABLE quality_pending_actions
  ADD CONSTRAINT quality_pending_actions_status_check
  CHECK (status IN ('pending', 'applied', 'rejected', 'superseded', 'cancelled'));

COMMIT;
