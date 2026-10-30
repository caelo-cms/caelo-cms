-- SPDX-License-Identifier: MPL-2.0
--
-- 0431 — the capabilities an Owner approved for a shipped plugin (#1267).
--
-- One plugin model (CLAUDE.md §2): who wrote a plugin grants nothing.
-- Runtime-installed plugins bind every grant to their artifact digest
-- (plugin_capability_grants, 0216). A release-signed plugin's grants were
-- implied by its manifest: a release that added a capability ran it on the
-- next boot without anyone deciding.
--
-- This column is a gate ADDED for release-signed plugins only. It does not
-- touch plugin_capability_grants or how runtime-installed plugins are
-- authorised, and it is not a per-digest grant: a release that keeps the
-- capability set runs without a new approval, as before (the gap
-- CMS_REQUIREMENTS §14 lists for shipped plugins). What changes is that a
-- release asking for a capability the Owner never approved no longer runs
-- it unasked.
--
-- approved_capabilities records what the Owner approved when they last
-- activated (or re-approved) the plugin. A release-signed plugin whose
-- manifest asks for a capability outside that set stays installed and
-- active — the Owner's status is never written by the host (#1008) — but
-- does not load until the Owner approves the new set at Settings →
-- Plugins; the reason is shown there, in list_plugins, and on Settings →
-- Updates. This release is the first to need it: international-site and
-- consent-manager move from the retired `domain_events` capability to
-- `change_journal`.
--
-- Backfill: every release-signed plugin that is active or disabled keeps
-- what it ran with — the capabilities of the manifest the previous release
-- recorded (this migration runs before the new images boot and rewrite
-- manifest_json). A plugin awaiting activation has approved nothing yet.
--
-- Expand-only (#696): a new nullable column; the previous release ignores it.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE plugins ADD COLUMN IF NOT EXISTS approved_capabilities text[] NULL;

UPDATE plugins
   SET approved_capabilities = ARRAY(
         SELECT jsonb_array_elements_text(
           CASE WHEN jsonb_typeof(manifest_json -> 'requestedCapabilities') = 'array'
                THEN manifest_json -> 'requestedCapabilities' ELSE '[]'::jsonb END))
 WHERE tier = 1 AND status IN ('active', 'disabled') AND approved_capabilities IS NULL;

COMMIT;
