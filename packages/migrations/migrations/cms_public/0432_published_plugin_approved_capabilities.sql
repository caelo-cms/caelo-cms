-- SPDX-License-Identifier: MPL-2.0
--
-- 0432 — #1267: the capability set an Owner approved for a release-signed
-- plugin (cms_admin `plugins.approved_capabilities`, migration 0431) is
-- published with the plugin registry, so the API gateway refuses to attach
-- a plugin that waits for approval exactly like the admin host does. The
-- gateway runs the definition shipped in its own image; it compares that
-- definition's requested capabilities with this set (gateway-attach.ts).
--
-- Not a contract migration: the column is nullable; the previous admin
-- publishes without it and the previous gateway does not read it. A row the
-- previous admin published reads as "nothing approved", so a new gateway
-- attaches no release-signed plugin that requests capabilities until the
-- new admin republishes the registry — which the migration run does
-- (public projection), and the admin rolls before the gateway.

ALTER TABLE published_plugins ADD COLUMN IF NOT EXISTS approved_capabilities text[] NULL;
