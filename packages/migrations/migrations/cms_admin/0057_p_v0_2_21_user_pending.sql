-- SPDX-License-Identifier: MPL-2.0
--
-- v0.2.21 — user_pending_actions: AI-proposed user lifecycle changes
-- (create / set_roles / delete) queued for Owner approval.
--
-- Same shape as deploy_pending (v0.2.19) and layout_pending (v0.2.20).
-- Security domain — AI proposes "invite Alice as Editor" or
-- "promote Bob to Admin"; the Owner clicks Approve at
-- /security/users/pending to actually mutate the security perimeter.
--
-- Critical security note: this table NEVER stores raw passwords. The
-- propose_create op accepts only email + displayName + roleNames; the
-- execute path generates a one-time temporary password server-side and
-- returns it for the Owner to share with the new user. AI does not
-- handle credential material.

CREATE TABLE IF NOT EXISTS user_pending_actions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('create', 'set_roles', 'delete')),
  proposed_by     uuid NOT NULL REFERENCES actors(id),
  -- Target user id (NULL for create — there's no row yet).
  user_id         uuid NULL REFERENCES users(id) ON DELETE CASCADE,
  payload         jsonb NOT NULL,
  preview         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'applied', 'rejected', 'superseded')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz NULL,
  decided_by      uuid NULL REFERENCES actors(id),
  decision_reason text NULL,
  applied_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS user_pending_actions_status_idx
  ON user_pending_actions (status, created_at DESC);

ALTER TABLE user_pending_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_pending_actions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_pending_actions_authenticated_scope ON user_pending_actions;
CREATE POLICY user_pending_actions_authenticated_scope ON user_pending_actions
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);
