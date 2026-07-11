-- SPDX-License-Identifier: MPL-2.0
--
-- 0105 — Site Genesis, slice 1 (issue #163, epic #149).
--
-- The two-level design architecture separates design-time (blank site:
-- divergent, freeform) from growth-time (existing site: convergent).
-- This migration lands the design-time storage:
--
--   - site_defaults.design_brief: the structured Design Brief captured
--     by the discovery dialog (audience, mood, tone, industry, imagery
--     direction, avoid-list). Written by site_defaults.set_identity —
--     AI-writable per CLAUDE.md §1A, snapshot-revertable like site
--     name/purpose.
--   - genesis_drafts: complete freeform single-file HTML drafts, one
--     per design direction, produced by parallel draft subagents. The
--     operator picks one at /design/genesis (or verbally in chat); the
--     selected draft is the design source the compiler (#164) derives
--     the CMS structure from.
--   - site-genesis skill: the workflow lives as a skill per CLAUDE.md
--     §2 ("skills are the official way to teach AI new behaviour"),
--     not as tool-handler prompt scaffolding.
--
-- At most ONE draft is selected (partial unique index): "the chosen
-- design" must be unambiguous for the compiler and the growth-time
-- surfaces that reference it.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE site_defaults
  ADD COLUMN IF NOT EXISTS design_brief JSONB;

COMMENT ON COLUMN site_defaults.design_brief IS
  'Structured Design Brief from the Genesis discovery dialog (audience, moodWords, tone, industry, differentiators, imageryDirection, avoid). Shape: packages/shared/src/genesis.ts designBriefSchema.';

CREATE TABLE genesis_drafts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Human-readable design direction ("bold editorial", "warm organic").
  direction   text NOT NULL,
  -- Why this direction fits the brief — decision-support context the
  -- selection UI and the AI's future self read (CLAUDE.md §1A).
  rationale   text NOT NULL DEFAULT '',
  -- Complete self-contained single-file HTML (inline CSS; no external
  -- deps beyond fonts). Rendered in a sandboxed iframe for selection.
  html        text NOT NULL,
  status      text NOT NULL DEFAULT 'candidate'
              CHECK (status IN ('candidate', 'selected', 'discarded')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Exactly one design can be "the chosen one".
CREATE UNIQUE INDEX genesis_drafts_single_selected
  ON genesis_drafts ((true)) WHERE status = 'selected';

ALTER TABLE genesis_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE genesis_drafts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS genesis_drafts_authenticated_scope ON genesis_drafts;
CREATE POLICY genesis_drafts_authenticated_scope ON genesis_drafts
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

INSERT INTO skills (slug, display_name, description, body, allowlisted_tools, auto_engagement_hints, status)
VALUES
  (
    'site-genesis',
    'Site Genesis',
    'Designs a brand-new site through divergent freeform drafts. Engaged when the operator wants a new website designed from scratch.',
    'You are running Site Genesis: the blank-site design flow. Design-time is DIVERGENT — the CMS structure comes later, FROM the chosen design; never design by composing tokens or modules first.

Workflow:
1. DISCOVERY — if `## Site identity` lacks a design brief, ask the operator (in one friendly message, not an interrogation) about: purpose, audience, desired mood (3-5 words), tone, industry, what makes them different, imagery direction, anything to avoid. Infer what the conversation already answered; only ask what is missing.
2. BRIEF — write it: `set_site_identity({siteName, sitePurpose, designBrief: {audience, moodWords, tone, industry, differentiators, imageryDirection, avoid}})`.
3. DIVERGE — pick 3 distinct design directions that fit the brief (e.g. "bold editorial", "clean minimal", "warm organic", "dark premium" — choose from the brief, not from a fixed menu). Spawn them IN PARALLEL via `spawn_subagents`, one task per direction. Each task must contain: the full brief, the direction, and these rules verbatim: "Return ONLY a complete self-contained index.html for the homepage: all CSS inline in one <style>, real copy written for this brand (no lorem ipsum), real typeface choices (name Google Fonts families in font-family stacks; do not link them), no external scripts or images (use CSS shapes/gradients where imagery would sit, with a short HTML comment naming the intended image). Design at the quality bar of a hand-built agency page: strong typographic hierarchy, real color palette with depth (gradients, surface tints, elevation), generous whitespace, mobile-first responsive." Use `expectedReturnShape: "freeform"`.
4. SAVE — `save_genesis_draft({direction, rationale, html})` for each returned draft. Do NOT paste draft HTML into the chat.
5. PRESENT — tell the operator: the drafts are ready to compare side-by-side at `/design/genesis`, or they can describe which direction they prefer right here. One sentence per draft on what makes it distinct.
6. SELECT — only after the operator explicitly picks: `select_genesis_draft({draftId})`. Iterate on a draft on request (edit the HTML, save a new revision via `save_genesis_draft` with the same direction + a rationale noting the change).
7. MATERIALISE — until the design compiler ships (#164), translate the SELECTED draft by hand, in this order: (a) `propose_create_theme` with tokens EXTRACTED from the draft (its exact palette incl. gradient/surface/shadow values, its typefaces) — never invent a different palette; (b) after approval + activation, build the page with `compose_page_from_spec`, re-expressing each draft section as a module whose CSS references the theme vars you just created.

Never skip the operator''s selection click (step 6) — the design choice is theirs.',
    '[]'::jsonb,
    '{"keywords":["new website","new site","from scratch","design my site","redesign everything","start over","homepage design","design directions","drafts","genesis"],"chipTrigger":false,"alwaysOn":false}'::jsonb,
    'active'
  );

COMMIT;
