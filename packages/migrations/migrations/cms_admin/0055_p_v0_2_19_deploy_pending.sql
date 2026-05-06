-- SPDX-License-Identifier: MPL-2.0
--
-- v0.2.19 — deploy_pending_actions: AI-proposed deploy actions
-- (promote / rollback) queued for Owner approval per the CLAUDE.md
-- §11.A propose/execute pattern. AI calls deploy.propose_<kind>
-- which inserts here at status='pending'; Owner clicks Approve at
-- /security/deployments/pending which calls deploy.execute_proposal
-- (human-only) → runs the underlying op → marks row 'applied'.
--
-- Why this op gets the gate: a promote moves staging → production
-- (visitor-facing); a rollback moves production back to a prior build
-- (visitor-facing too). Both are "production-affecting" per
-- CMS_REQUIREMENTS §6 + CLAUDE.md §11.A. AI proposes the change with
-- a computed preview; the Owner clicks one button.
--
-- First exemplar of Category D propose/execute. Subsequent gated
-- domains (users, roles, layouts, gateway, ...) get their own
-- *_pending_actions tables following this shape.

CREATE TABLE IF NOT EXISTS deploy_pending_actions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Discriminator across deploy ops that need the gate. v0.2.19
  -- supports 'promote' + 'rollback'; other deploy ops stay direct.
  kind            text NOT NULL CHECK (kind IN ('promote', 'rollback')),
  proposed_by     uuid NOT NULL REFERENCES actors(id),
  -- Original op input (e.g. {fromTarget, toTarget, repoRoot?}).
  payload         jsonb NOT NULL,
  -- Computed at propose time: source-of-truth summary of what
  -- approving will do (target build id, page count, file count). The
  -- Owner UI renders this verbatim so the click decision has full
  -- context.
  preview         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'applied', 'rejected')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz NULL,
  decided_by      uuid NULL REFERENCES actors(id),
  decision_reason text NULL,
  -- Once applied, captures the resulting deploy_run id so the Owner
  -- UI can link "your approval triggered this run".
  applied_run_id  uuid NULL REFERENCES deploy_runs(id)
);

CREATE INDEX IF NOT EXISTS deploy_pending_actions_status_idx
  ON deploy_pending_actions (status, created_at DESC);

ALTER TABLE deploy_pending_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE deploy_pending_actions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deploy_pending_actions_authenticated_scope ON deploy_pending_actions;
CREATE POLICY deploy_pending_actions_authenticated_scope ON deploy_pending_actions
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);
