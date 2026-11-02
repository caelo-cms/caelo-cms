-- SPDX-License-Identifier: MPL-2.0
--
-- 0510 — a shipped plugin's approval is bound to its manifest (#1332).
--
-- CLAUDE.md §2: every grant is bound to the exact artifact; a new version is
-- a new artifact and is re-approved. Since 0431 a release-signed plugin was
-- gated only on its capability SET, so a release that changed what visitors
-- can reach (its public operations, its table kinds) ran without anyone
-- deciding. This column records the digest of the manifest the Owner
-- approved (plugin-sandbox `releaseManifestDigest`). A release-signed plugin
-- whose manifest has another digest stays installed and active — its status
-- is the Owner's (#1008) — but neither the admin host nor the API gateway
-- runs it until the Owner approves this release at Settings → Plugins.
-- Publish live refuses while it does not run, and says why.
--
-- No SQL backfill: the digest is computed over canonical JSON in the host,
-- which jsonb's own key order cannot reproduce. The admin host records the
-- digest of the manifest a plugin already ran with the first time it loads
-- a release over a row without one (loader.ts), so a release that leaves a
-- manifest unchanged keeps running and one that changes it waits.
--
-- Expand-only (#696): a new nullable column; the previous release ignores it.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE plugins
  ADD COLUMN IF NOT EXISTS approved_manifest_digest text NULL
  CONSTRAINT plugins_approved_manifest_digest_hex
    CHECK (approved_manifest_digest IS NULL OR approved_manifest_digest ~ '^[0-9a-f]{64}$');

COMMIT;
