-- SPDX-License-Identifier: MPL-2.0
--
-- v0.6.0 W5 — `tool_approval_actions`: persistence for AI tool calls
-- gated by the `needsApproval` predicate on `ToolDefinitionWithHandler`.
-- Same shape as the per-domain `*_pending_actions` tables shipped in
-- v0.2.20+ (layouts, deploy, roles, …) but tool-name-keyed instead of
-- domain-keyed. Lets a NEW gated tool ship without a per-domain
-- `propose_*` op + table — the tool just declares `needsApproval` and
-- the dispatcher persists the call here.
--
-- Why this exists separately from the propose/* tables: those carry
-- domain-specific preview metadata + audit history that justifies the
-- per-domain table. The needsApproval gate is for cases where a single
-- bool predicate + an opaque preview JSON is enough — no domain-
-- specific columns, no per-domain UI page. delete_pages_many at 5+ is
-- the canonical example.

CREATE TABLE IF NOT EXISTS tool_approval_actions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Tool name (matches ToolDefinitionWithHandler.name) — used by the
  -- approve route to dispatch via createDefaultToolRegistry().
  tool_name         text NOT NULL,
  -- Original parsed args. Re-validated against the tool's Zod schema
  -- on execute so a schema-tightening between propose+approve doesn't
  -- silently apply stale args.
  args              jsonb NOT NULL,
  -- buildApprovalPreview output. Rendered to the operator alongside
  -- the tool name in the approve queue.
  preview           jsonb NOT NULL,
  -- Chat session that proposed this. Lets the queue page filter by
  -- chat AND lets the approve handler post a follow-up "applied"
  -- message back into the chat so the AI sees the result.
  chat_session_id   uuid NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  proposed_by       uuid NOT NULL REFERENCES actors(id),
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'applied', 'rejected', 'superseded')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  decided_at        timestamptz NULL,
  decided_by        uuid NULL REFERENCES actors(id),
  decision_reason   text NULL,
  -- Captured AFTER execute_proposal runs the tool. Lets the queue
  -- page show "applied at <time>: <result>" without re-fetching from
  -- another table.
  result_ok         boolean NULL,
  result_summary    text NULL
);

CREATE INDEX IF NOT EXISTS tool_approval_actions_status_idx
  ON tool_approval_actions (status, created_at DESC);
CREATE INDEX IF NOT EXISTS tool_approval_actions_chat_session_idx
  ON tool_approval_actions (chat_session_id, created_at DESC)
  WHERE chat_session_id IS NOT NULL;

ALTER TABLE tool_approval_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_approval_actions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tool_approval_actions_authenticated_scope ON tool_approval_actions;
CREATE POLICY tool_approval_actions_authenticated_scope ON tool_approval_actions
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);
