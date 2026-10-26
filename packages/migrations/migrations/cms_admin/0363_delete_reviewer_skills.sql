-- SPDX-License-Identifier: MPL-2.0
--
-- 0363 — delete the subagent reviewer skills seeded by 0033 (qa-check,
-- legal-check, menu-auditor, page-categorizer).
--
-- Subagents are a build-throughput tool, never a way for the AI to review
-- its own work (system prompt `## Subagents`). Quality review runs as the
-- automatic quality check on every Stage (Lighthouse + the page checks
-- plugins add), not as a skill the AI chooses to spawn. A future legal
-- check ships as a plugin, and its usage guidance as that plugin's skill.
--
-- Deleted, not archived: they are core seed rows with no replacement, and
-- an archived row would keep them in the Owner's skill list for nothing.
-- skill_pin_defaults rows cascade; skill_proposals keep their history with
-- resulting_skill_id set to NULL. Plugin-owned rows are never touched.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

DELETE FROM skills
 WHERE slug IN ('qa-check', 'legal-check', 'menu-auditor', 'page-categorizer')
   AND plugin_id IS NULL;

COMMIT;
