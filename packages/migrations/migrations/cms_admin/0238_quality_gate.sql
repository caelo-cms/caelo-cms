-- SPDX-License-Identifier: MPL-2.0
--
-- 0238 — issue #553 PR 2: the quality gate on Publish live.
--
-- quality_audit_runs gains:
--   fix_round          0 for the first audit of a chat's problems, then
--                      1, 2 for each re-Stage while problems remain. The
--                      chat asks the AI to fix automatically only while
--                      fix_round < 2 (the 2-round cap of #553).
--   chat_notified_at   when the originating chat got the result (delivered
--                      and acknowledged), so it is posted exactly once.
--   chat_notify_claimed_at  a short lease while one chat tab delivers it;
--                      an expired lease (tab closed, send failed) lets the
--                      next poll deliver it again.
--   retry_of           the failed audit a retry re-runs.
--   publish_override_* an editor's explicit "publish anyway" over a
--                      FAILED audit (never over problems): who, why, when.
--
-- quality_pending_actions — the standard propose/execute table (CLAUDE.md
-- §11.A) behind the in-chat approval cards: 'accept' (accept findings /
-- score drops on pages) and 'publish_anyway' (publish over a failed
-- audit). The AI proposes; only a human click applies.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE quality_audit_runs
  ADD COLUMN fix_round integer NOT NULL DEFAULT 0 CHECK (fix_round >= 0),
  ADD COLUMN chat_notified_at timestamptz NULL,
  ADD COLUMN chat_notify_claimed_at timestamptz NULL,
  ADD COLUMN retry_of uuid NULL REFERENCES quality_audit_runs(id) ON DELETE SET NULL,
  ADD COLUMN publish_override_by uuid NULL REFERENCES actors(id),
  ADD COLUMN publish_override_reason text NULL,
  ADD COLUMN publish_override_at timestamptz NULL,
  ADD CONSTRAINT quality_audit_runs_override_shape CHECK (
    (publish_override_by IS NULL) = (publish_override_at IS NULL)
    AND (publish_override_by IS NULL) = (publish_override_reason IS NULL)
    AND (publish_override_by IS NULL OR status = 'errored')
  );

CREATE TABLE quality_pending_actions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('accept', 'publish_anyway')),
  proposed_by     uuid NOT NULL REFERENCES actors(id),
  audit_run_id    uuid NULL REFERENCES quality_audit_runs(id) ON DELETE CASCADE,
  payload         jsonb NOT NULL,
  preview         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'applied', 'rejected', 'superseded')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz NULL,
  decided_by      uuid NULL REFERENCES actors(id),
  decision_reason text NULL,
  chat_session_id uuid NULL REFERENCES chat_sessions(id) ON DELETE SET NULL,
  payload_hash    text NULL
);

CREATE INDEX quality_pending_actions_status_idx
  ON quality_pending_actions (status, created_at DESC);
CREATE UNIQUE INDEX quality_pending_actions_payload_hash_pending_uniq
  ON quality_pending_actions (payload_hash) WHERE status = 'pending' AND payload_hash IS NOT NULL;

ALTER TABLE quality_pending_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality_pending_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY quality_pending_actions_authenticated_scope ON quality_pending_actions
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

COMMIT;
