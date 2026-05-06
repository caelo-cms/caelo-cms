-- SPDX-License-Identifier: MPL-2.0
--
-- v0.2.20 — layout_pending_actions: AI-proposed layout actions
-- (create / update / delete / set_blocks) queued for Owner approval.
-- Same shape as deploy_pending_actions (v0.2.19) so subsequent
-- gated domains slot into the pattern with copy-paste.
--
-- Why layouts get the gate: a layout is the site shell — chrome that
-- shows up on every page bound to every template that uses it.
-- Creating a new one doesn't yet affect any page (safe-ish), but
-- update/delete/set_blocks cascade across every active page
-- instantly. AI proposes the change with the affected-template-count
-- + affected-page-count baked into the preview; Owner clicks Approve
-- with full blast-radius context.

CREATE TABLE IF NOT EXISTS layout_pending_actions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('create', 'update', 'delete', 'set_blocks')),
  proposed_by     uuid NOT NULL REFERENCES actors(id),
  -- Target layout id (NULL for create — there's no row yet).
  layout_id       uuid NULL REFERENCES layouts(id) ON DELETE CASCADE,
  -- Original op input.
  payload         jsonb NOT NULL,
  -- Computed at propose time: affected templates + pages, slug, etc.
  preview         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'applied', 'rejected', 'superseded')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz NULL,
  decided_by      uuid NULL REFERENCES actors(id),
  decision_reason text NULL,
  -- After apply: the resulting layout id (for create) or unchanged
  -- target (for update/delete/set_blocks).
  applied_layout_id uuid NULL REFERENCES layouts(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS layout_pending_actions_status_idx
  ON layout_pending_actions (status, created_at DESC);

ALTER TABLE layout_pending_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE layout_pending_actions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS layout_pending_actions_authenticated_scope ON layout_pending_actions;
CREATE POLICY layout_pending_actions_authenticated_scope ON layout_pending_actions
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);
