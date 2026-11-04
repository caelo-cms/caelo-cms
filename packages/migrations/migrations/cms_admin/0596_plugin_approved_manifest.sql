-- SPDX-License-Identifier: MPL-2.0
--
-- 0596 — the Owner sees what a plugin release changes (#1420).
--
-- `approved_manifest_digest` says THAT a release differs from the approved
-- one, not HOW: the previous manifest is overwritten when the release
-- loads. `approved_manifest_json` keeps the manifest the digest stands for,
-- so the approval dialog can name what changed (CMS_REQUIREMENTS §14.5).
-- A plugin already waiting when this lands has no such row; the dialog says
-- the previous version is unknown instead of guessing.
--
-- No SQL backfill for the same reason as 0510: the digest is computed in
-- the host. The loader records the manifest the first time it loads a
-- release over a row whose stored manifest is the approved one.
--
-- `approve_release` joins the plugin queue: the AI proposes it in the chat
-- (`plugins.propose_approve_release`), the Owner's click applies it.
--
-- Expand-only (#696): a nullable column and a wider CHECK; the previous
-- release ignores both.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE plugins ADD COLUMN IF NOT EXISTS approved_manifest_json jsonb NULL;

ALTER TABLE plugin_pending_actions DROP CONSTRAINT IF EXISTS plugin_pending_actions_kind_check;
ALTER TABLE plugin_pending_actions
  ADD CONSTRAINT plugin_pending_actions_kind_check
  CHECK (kind IN ('uninstall', 'activate', 'revoke_capability', 'approve_release'));

-- The inbox reads the installations awaiting review on every bell read.
CREATE INDEX IF NOT EXISTS plugin_installation_versions_pending_idx
  ON plugin_installation_versions (plugin_id) WHERE status = 'pending';

COMMIT;
