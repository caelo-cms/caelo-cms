-- SPDX-License-Identifier: MPL-2.0
--
-- 0260 — issue #685: a quality fix round starts only on the operator's click.
--
-- After a Stage whose quality check found problems, the Live Edit chat used
-- to send the AI its fix round on its own — also when the operator had
-- clicked Stage, or another agent had staged. The chat now asks first
-- ("Let the AI fix them?"), and the fix request it sends on "Fix with AI"
-- tells the AI who staged the build, so it does not assume it made every
-- staged change itself.
--
-- `staged_by` records that origin for a chat Stage's audit:
--   operator      the operator's Stage (Stage button, Open changes)
--   live_edit_ai  the Live Edit AI's own stage_changes in the operator's chat
--   other_agent   stage_changes from another agent (an external MCP agent
--                 working in the chat, or a subagent)
-- NULL for audits outside a chat (Ops deploy, the pages list, the automatic
-- redeploy) and for runs from before this migration.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE quality_audit_runs
  ADD COLUMN staged_by text NULL
    CHECK (staged_by IS NULL OR staged_by IN ('operator', 'live_edit_ai', 'other_agent'));

COMMIT;
