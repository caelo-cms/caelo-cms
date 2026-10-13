-- SPDX-License-Identifier: MPL-2.0
--
-- 0262 — issue #687: remember the branch a queued tool call was proposed on.
--
-- Approval-declared plugin tools called by an external agent over the
-- Power-MCP now queue in tool_approval_actions (they cannot pause an SDK
-- turn there). On Approve the plugin call runs like the in-chat gate: live
-- when the approver may publish, otherwise on the proposing session's
-- branch; an external plugin's installation binding is keyed by that branch.
--
-- The session's current branch is not good enough: chat.isolate_session
-- moves a session to a new branch, so a call queued before the move would
-- redeem its binding against the wrong branch (refused, and the proposal
-- consumed) or write to a branch it was never proposed on. The branch is
-- recorded once, at queue time, and never changes.
--
-- NULL for rows queued before this migration and for calls queued outside
-- a chat branch; those apply live, as before.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE tool_approval_actions ADD COLUMN IF NOT EXISTS chat_branch_id uuid NULL;

COMMIT;
