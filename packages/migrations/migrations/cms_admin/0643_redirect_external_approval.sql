-- SPDX-License-Identifier: MPL-2.0
--
-- 0643 — issue #1358: redirects to another domain. The §11.A queue: a
-- redirect to an https address lends the site's domain to that address and
-- ends up on printed QR codes, so the AI proposes and an Owner approves.
-- Docs: docs/dev/redirects-and-settings-sync.md.
--
-- The rows themselves stay in `redirects`: `to_path` holds the URL. Nothing
-- but `redirects.execute_proposal` writes one (the routine ops' target check
-- refuses every value that does not start with a single '/').

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE redirect_pending_actions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('set_external')),
  proposed_by     uuid NOT NULL REFERENCES actors(id),
  payload         jsonb NOT NULL,
  preview         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'applied', 'rejected', 'superseded', 'cancelled')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz,
  decided_by      uuid REFERENCES actors(id),
  decision_reason text,
  chat_session_id uuid REFERENCES chat_sessions(id) ON DELETE SET NULL,
  payload_hash    text
);
CREATE UNIQUE INDEX redirect_pending_actions_payload_hash_pending_uniq
  ON redirect_pending_actions (payload_hash)
  WHERE status = 'pending' AND payload_hash IS NOT NULL;
CREATE INDEX redirect_pending_actions_status_idx
  ON redirect_pending_actions (status, created_at DESC);
CREATE INDEX redirect_pending_actions_proposed_by_idx
  ON redirect_pending_actions (proposed_by);
CREATE INDEX redirect_pending_actions_decided_by_idx
  ON redirect_pending_actions (decided_by);
CREATE INDEX redirect_pending_actions_chat_session_idx
  ON redirect_pending_actions (chat_session_id);

ALTER TABLE redirect_pending_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE redirect_pending_actions FORCE ROW LEVEL SECURITY;
-- Any authenticated actor session; who may write what is decided at the op.
CREATE POLICY redirect_pending_actions_authenticated_scope ON redirect_pending_actions
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

COMMIT;
