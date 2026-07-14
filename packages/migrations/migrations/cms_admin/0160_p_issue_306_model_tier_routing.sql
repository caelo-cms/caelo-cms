-- SPDX-License-Identifier: MPL-2.0
--
-- 0160 — multi-model routing (issue #306): Owner observability columns +
-- site-migrate tier steering.
--
-- Part 1: subagent_runs learns WHICH model tier a run was dispatched at
-- (`model_tier`: inherit/mid/small) and WHICH concrete model served it
-- (`model`). The subagent security panel + cost analysis need this to
-- measure router effectiveness (which tier built what, at what cost);
-- ai_calls already records model per call, but the RUN-level tier intent
-- (including "small child was escalated") only exists here. NULL for
-- rows predating this migration. Owner surface only — editors never see
-- tier or model names (CLAUDE.md §2 brand rule).
--
-- The tier→model MAPPING itself needs no schema: it lives in the active
-- provider row's config jsonb (`ai_providers.config.modelTiers`), the
-- same home as `model` / `maxOutputTokens`. Absent mapping = tiering
-- off = pre-#306 single-model behaviour.
--
-- Part 2 (guarded skill amendment): the site-migrate fan-out phase
-- passes tier "mid" for page-type builder subagents and tier "small"
-- for bulk content-fill batches — ONLY when tiering is enabled on the
-- install; the spawn tool fails loudly (nothing spawns) when a tier is
-- unmapped, and the skill tells the AI how to recover in one step.
-- Guarded + idempotent like 0131/0132/0151/0154: anchors on the 0150
-- fan-out sentence and no-ops once the tier text is in place.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE subagent_runs
  ADD COLUMN IF NOT EXISTS model_tier text NULL
    CHECK (model_tier IN ('inherit','mid','small')),
  ADD COLUMN IF NOT EXISTS model text NULL;

--> statement-breakpoint

UPDATE skills
SET body = replace(
  body,
  'EVERY page gets its OWN AI pass (operator constraint, issue #268): parallelise with `spawn_subagents` — DISJOINT page sets per subagent so no two touch the same page or the same shared module.',
  'EVERY page gets its OWN AI pass (operator constraint, issue #268): parallelise with `spawn_subagents` — DISJOINT page sets per subagent so no two touch the same page or the same shared module. MODEL TIERS (issue #306, only if enabled on this install): pass tier "mid" on subagents that BUILD a page type''s template + representative page (pattern application from the approved design), and tier "small" on subagents that only FILL a type''s remaining pages into the already-built pattern (mechanical bulk content work). If the spawn call fails because a tier is not configured, re-issue the SAME call once WITHOUT the tier fields — the install runs single-model and that is fine. Small-tier children hand pages needing NEW build decisions back as needs_escalation and the tool re-dispatches them a tier up automatically — do not treat that as a failure. NEVER mention tiers or model names to the operator; they see only progress.'
)
WHERE slug = 'site-migrate'
  AND body LIKE '%EVERY page gets its OWN AI pass (operator constraint, issue #268)%'
  AND body NOT LIKE '%MODEL TIERS (issue #306%';

COMMIT;
