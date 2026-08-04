-- SPDX-License-Identifier: MPL-2.0
--
-- 0198 — Design Preview: growth-time design variants (issue #375).
--
-- Generalises the Genesis draft loop (draft → present → select →
-- materialise, #163) from "whole new site" to variants of an EXISTING
-- page or single module:
--
--   - genesis_drafts gains scope (site|page|module), target refs, a
--     variant_set grouping id (one request's variants = one
--     comparison), and format (document|fragment). Site scope is the
--     unchanged Genesis case; page/module drafts are fragments bound
--     to the site's var(--…) tokens, composed into the REAL theme
--     shell only at view time (#375: never an AI approximation of the
--     theme — a stored variant must not freeze a stale theme copy).
--   - the draft tools are renamed genesis→design (save_design_draft,
--     list_design_drafts, select_design_draft, inspect_design_draft):
--     the AI reaches for them at growth-time too, where "genesis"
--     would misroute (CLAUDE.md §1A/§11). Skill bodies + allowlists
--     are rewritten in place (replace() is idempotent).
--   - design-preview skill: the workflow lives as a skill per
--     CLAUDE.md §2, not as tool-handler prompt scaffolding.
--
-- Selection invariants: exactly one selected draft PER VARIANT SET
-- (the comparison's outcome), and — unchanged from 0105 — exactly one
-- selected SITE draft overall ("the chosen design" stays unambiguous
-- for the compiler and the growth-time surfaces that reference it).

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE genesis_drafts
  ADD COLUMN scope text NOT NULL DEFAULT 'site'
    CHECK (scope IN ('site', 'page', 'module')),
  ADD COLUMN format text NOT NULL DEFAULT 'document'
    CHECK (format IN ('document', 'fragment')),
  -- Soft refs by design (no FK): drafts are throwaway candidates; a
  -- deleted target must not cascade away the audit trail of what was
  -- proposed, and page/module rows live under branch semantics the
  -- draft does not participate in.
  ADD COLUMN target_page_id uuid NULL,
  ADD COLUMN target_module_id uuid NULL,
  ADD COLUMN variant_set uuid NULL;

-- One shared set for every pre-#375 row: the Genesis comparison was
-- (and remains) a single side-by-side set.
UPDATE genesis_drafts g
SET variant_set = s.u
FROM (SELECT gen_random_uuid() AS u) s
WHERE g.variant_set IS NULL;

ALTER TABLE genesis_drafts
  ALTER COLUMN variant_set SET NOT NULL;

-- Format is fully determined by scope today; the paired CHECK keeps
-- that loud instead of tribal (packages/shared draftFormatForScope).
ALTER TABLE genesis_drafts
  ADD CONSTRAINT genesis_drafts_scope_format
    CHECK ((scope = 'site') = (format = 'document')),
  ADD CONSTRAINT genesis_drafts_scope_targets
    CHECK (
      (scope = 'site' AND target_page_id IS NULL AND target_module_id IS NULL)
      OR (scope = 'page' AND target_page_id IS NOT NULL AND target_module_id IS NULL)
      OR (scope = 'module' AND target_module_id IS NOT NULL)
    );

COMMENT ON COLUMN genesis_drafts.scope IS
  'What the draft covers: site (Genesis — complete standalone document), page or module (growth-time variant fragment, issue #375).';
COMMENT ON COLUMN genesis_drafts.format IS
  'document = complete standalone HTML; fragment = token-bound HTML composed into the real theme shell at view time (issue #375).';
COMMENT ON COLUMN genesis_drafts.variant_set IS
  'Groups one request''s variants into one comparison; selection is per set (issue #375).';

DROP INDEX genesis_drafts_single_selected;
CREATE UNIQUE INDEX genesis_drafts_single_selected_site
  ON genesis_drafts ((true)) WHERE status = 'selected' AND scope = 'site';
CREATE UNIQUE INDEX genesis_drafts_selected_per_set
  ON genesis_drafts (variant_set) WHERE status = 'selected';

-- ---------------------------------------------------------------
-- Tool rename genesis→design across every skill body + allowlist.
-- replace() is idempotent; operator-edited bodies keep their edits.
-- Order matters: list_genesis_drafts before select/save would not
-- collide, but keep each replacement exact-name anyway.
-- ---------------------------------------------------------------

UPDATE skills SET
  body = replace(replace(replace(replace(body,
    'save_genesis_draft', 'save_design_draft'),
    'list_genesis_drafts', 'list_design_drafts'),
    'select_genesis_draft', 'select_design_draft'),
    'inspect_genesis_draft', 'inspect_design_draft'),
  allowlisted_tools = replace(replace(replace(replace(allowlisted_tools::text,
    '"save_genesis_draft"', '"save_design_draft"'),
    '"list_genesis_drafts"', '"list_design_drafts"'),
    '"select_genesis_draft"', '"select_design_draft"'),
    '"inspect_genesis_draft"', '"inspect_design_draft"')::jsonb
WHERE body LIKE '%genesis_draft%' OR allowlisted_tools::text LIKE '%genesis_draft%';

-- site-genesis: the same loop covers a full redesign of an EXISTING
-- site (deferred in #163, delivered by #375). Guarded append.
UPDATE skills SET body = body || '

FULL REDESIGN of an EXISTING site (issue #375): run this same flow — scope stays "site", drafts are complete standalone documents (deliberately NOT wrapped in the current theme: the redesign exists to escape it). Materialisation goes through the theme gate (`propose_create_theme`, Owner click) before any module restyling. For variants of a single page or module within the CURRENT design, use the design-preview skill instead.'
WHERE slug = 'site-genesis' AND body NOT LIKE '%issue #375%';

-- design-quality: route design-proposal asks into the preview loop.
UPDATE skills SET body = body || '

Design proposals for something that already exists (a page, a section, a module — "show me options", "this feels stale"): do NOT restyle live modules to demonstrate ideas. Run the design-preview skill loop: draft token-bound variants, present them, and only materialise the operator''s pick (issue #375).'
WHERE slug = 'design-quality' AND body NOT LIKE '%design-preview skill loop%';

-- ---------------------------------------------------------------
-- The design-preview skill.
-- ---------------------------------------------------------------

INSERT INTO skills (slug, display_name, description, body, allowlisted_tools, auto_engagement_hints, status)
VALUES
  (
    'design-preview',
    'Design Preview',
    'Presents design variants of an existing page or module as throwaway previews before anything is changed. Engaged when the operator asks for design proposals, a redesign, or options.',
    'You are running Design Preview: the growth-time design-variant flow (issue #375). The operator asked for design proposals, a redesign, or options for something that ALREADY EXISTS (a page, a section, a module). Do NOT restyle live modules or the theme to demonstrate ideas — draft variants, let the operator pick, then materialise only the pick.

WHEN this flow applies: exploratory or taste-driven asks ("make it feel more premium", "show me some options", "the hero feels stale", "redesign the pricing section"). WHEN NOT: a concrete small instruction ("make the button red", "more spacing") — edit the module directly. A whole NEW site is Site Genesis (site-genesis skill); a full redesign of an existing site is ALSO Site Genesis (scope "site"), not this flow.

Workflow:
1. SENSE — read the real thing you are restyling: `inspect_page_render` for the target''s HTML+CSS, the `## Design system` block for the site''s token roles and patterns. Variants must carry the target''s REAL copy and imagery (never lorem ipsum) and must style through the site''s `var(--…)` theme tokens — the preview composes each variant into the site''s actual theme shell (real fonts, palette, base styles), so invented token names render visibly broken.
2. DIVERGE — 2–4 variants. For "improve this" asks stay within the site''s design system (re-expressions, not departures); for explicit redesign asks pick genuinely distinct directions. Draft page-scope variants via parallel `spawn_subagents` (one per variant); single-module variants you can draft inline. Each variant is an HTML FRAGMENT: the section''s markup + one <style> block using var(--…) tokens. No <html>/<head>, no scripts, real content.
3. SAVE — `save_design_draft({scope: "module"|"page", targetModuleId|targetPageId, direction, rationale, html})` per variant. The FIRST save returns `variantSetId`; pass it on every sibling save so the round compares as ONE set. Do NOT paste draft HTML into the chat.
4. PRESENT — `present_design_variants({variantSetId})`: the variants render inline in the chat, composed into the real theme, each with a pick button; the operator can also compare full-size at /design/genesis. Add one sentence per variant on what makes it distinct, then END YOUR TURN and wait.
5. ITERATE — feedback on a variant = save a NEW draft in the SAME set (same direction, rationale noting the change), present again.
6. SELECT — only after the operator explicitly picks (button click or words): `select_design_draft({draftId})`. The choice is theirs; never pick for them, never skip this step.
7. MATERIALISE — re-express the SELECTED variant in the real target on the current chat branch: `edit_module` for module scope; the page''s modules for page scope. `inspect_design_draft({draftId, includeHtml: true})` returns the fragment when you need the markup. The fragment is already token-bound — transfer it faithfully; the result must match the picked preview.

If the operator rejects all variants: stop. No module writes, no theme writes — discard is the successful outcome of a cheap loop.',
    '["save_design_draft","list_design_drafts","select_design_draft","present_design_variants","inspect_design_draft","inspect_page_render","screenshot_page","edit_module","spawn_subagents"]'::jsonb,
    '{"keywords":["design proposal","design proposals","design options","variants","redesign","restyle","new look","looks dated","feels stale","modernize","designvorschläge","varianten","neues design"],"chipTrigger":false,"alwaysOn":false}'::jsonb,
    'active'
  );

COMMIT;
