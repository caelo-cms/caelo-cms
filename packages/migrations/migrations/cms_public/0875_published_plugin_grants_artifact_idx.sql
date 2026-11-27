-- SPDX-License-Identifier: MPL-2.0
--
-- 0875 — #1729: find a runtime-installed plugin's published grants by its
-- artifact.
--
-- Every gateway call of a runtime-installed plugin first checks that the
-- approval it was loaded with still holds (plugin-host
-- external-authorization.ts), which reads the grants of the artifact it
-- runs (published-state.ts). With installed plugins brokered every
-- capability, visitors reach that read (a sign-up queueing the plugin's
-- mail, for one); without this index each call scans every published grant
-- of the install. The query index gate found it once a test made the call
-- through the gateway.
--
-- Not a contract migration: an added index, which the previous release's
-- gateway uses too.

CREATE INDEX IF NOT EXISTS published_plugin_grants_artifact_idx
  ON published_plugin_grants (plugin_id, artifact_digest);
