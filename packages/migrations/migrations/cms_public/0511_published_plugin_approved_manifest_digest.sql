-- SPDX-License-Identifier: MPL-2.0
--
-- 0511 — #1332: the manifest digest an Owner approved for a release-signed
-- plugin (cms_admin `plugins.approved_manifest_digest`, migration 0510) is
-- published with the plugin registry, so the API gateway attaches a shipped
-- plugin only when its own image's manifest is the approved one, exactly
-- like the admin host (gateway-attach.ts).
--
-- Not a contract migration: the column is nullable; the previous admin
-- publishes without it and the previous gateway does not read it. A row the
-- previous admin published reads as "nothing approved", so a new gateway
-- attaches no release-signed plugin until the new admin republishes the
-- registry — which the migration run does (public projection).

ALTER TABLE published_plugins
  ADD COLUMN IF NOT EXISTS approved_manifest_digest text NULL
  CHECK (approved_manifest_digest IS NULL OR approved_manifest_digest ~ '^[0-9a-f]{64}$');
