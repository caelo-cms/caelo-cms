-- SPDX-License-Identifier: MPL-2.0
--
-- 0330 — issues #904 / #905 / #906: forward AI bug reports to the Caelo team.
--
-- telemetry_settings (the opt-in singleton of P16) gains the bug-forwarding
-- consent and the install's signing identity for the Caelo bug intake:
--
--   bug_forwarding_enabled      the Owner's consent; off by default
--   bug_forwarding_decided_at   when the Owner answered (yes or no), so the
--                               question is asked once and not again
--   bug_intake_public_key       raw Ed25519 public key, base64
--   bug_intake_private_key_*    the private key (PKCS#8) encrypted
--                               with the install KEK (security/secret-box.ts),
--                               same scheme as ai_providers keys; ciphertext
--                               and IV stored base64
--   bug_intake_registered_at    when the intake pinned the public key
--
-- ai_bug_reports gains the outbox + upstream state per report:
--
--   fingerprint            deterministic defect identity (shared/bug-intake.ts)
--   forward_attempts       sends tried so far
--   next_forward_at        earliest next send; also the claim lease, so two
--                          admin instances never send the same row at once
--   forward_error          last refusal or failure, shown on /settings/bugs
--   forwarded_at           when the intake accepted it
--   upstream_*             the cluster it joined: id, status, public issue
--                          URL, first release with the fix, last refresh
--
-- The telemetry_settings write policy is also corrected: 0048 allowed writes
-- only for `system`, so the Owner's own toggle (telemetry.set, a human op)
-- was refused by RLS. Consent is the human's act; the AI still never writes
-- here (the ops are human/system only, and the policy refuses `ai`).
--
-- Expand-safe: new nullable/defaulted columns only; the previous release
-- neither reads nor writes them.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE telemetry_settings
  ADD COLUMN IF NOT EXISTS bug_forwarding_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS bug_forwarding_decided_at timestamptz,
  ADD COLUMN IF NOT EXISTS bug_intake_public_key text,
  ADD COLUMN IF NOT EXISTS bug_intake_private_key_ciphertext text,
  ADD COLUMN IF NOT EXISTS bug_intake_private_key_iv text,
  ADD COLUMN IF NOT EXISTS bug_intake_private_key_kek_fp text,
  ADD COLUMN IF NOT EXISTS bug_intake_registered_at timestamptz;

DROP POLICY IF EXISTS telemetry_settings_authed ON telemetry_settings;
CREATE POLICY telemetry_settings_authed ON telemetry_settings
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (current_setting('caelo.actor_kind', true) IN ('human', 'system'));

ALTER TABLE ai_bug_reports
  ADD COLUMN IF NOT EXISTS fingerprint text,
  ADD COLUMN IF NOT EXISTS forward_attempts int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_forward_at timestamptz,
  ADD COLUMN IF NOT EXISTS forward_error text,
  ADD COLUMN IF NOT EXISTS forwarded_at timestamptz,
  ADD COLUMN IF NOT EXISTS upstream_cluster_id text,
  ADD COLUMN IF NOT EXISTS upstream_status text
    CHECK (upstream_status IN ('open', 'fixed', 'regression', 'wontfix')),
  ADD COLUMN IF NOT EXISTS upstream_issue_url text,
  ADD COLUMN IF NOT EXISTS upstream_fixed_in text,
  ADD COLUMN IF NOT EXISTS upstream_checked_at timestamptz;

CREATE INDEX IF NOT EXISTS ai_bug_reports_forward_due_idx
  ON ai_bug_reports (next_forward_at NULLS FIRST)
  WHERE forwarding_state = 'queued';

CREATE INDEX IF NOT EXISTS ai_bug_reports_upstream_cluster_idx
  ON ai_bug_reports (upstream_cluster_id)
  WHERE upstream_cluster_id IS NOT NULL;

COMMIT;
