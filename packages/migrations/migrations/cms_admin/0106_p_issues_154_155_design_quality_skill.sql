-- SPDX-License-Identifier: MPL-2.0
--
-- 0106 — design-quality base skill (#154) + screenshot self-review
-- loop (#155), epic #149.
--
-- All design-craft guidance so far lives in the `## Theme` block and
-- is token/color-focused; nothing teaches layout, typography, rhythm,
-- or the look-at-your-work loop. Per CLAUDE.md §2 both behaviours ship
-- as skills (overridable per chat — an operator who wants brutalist
-- can disengage), never as tool-handler prompt scaffolding.
--
-- The compose-page body update is guarded (only when the self-review
-- marker is absent) so operator-edited skills are never clobbered and
-- a re-run is a no-op.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

INSERT INTO skills (slug, display_name, description, body, allowlisted_tools, auto_engagement_hints, status)
VALUES
  (
    'design-quality',
    'Design quality',
    'Layout, typography, and visual-hierarchy craft for visitor-facing pages. Engaged whenever the AI composes or restyles anything the visitor sees.',
    'You are shaping visitor-facing design. Hold every section you author or restyle to this bar — the operator will not ask for these; they are your craft:

HIERARCHY — one focal point per section. Hero pattern: eyebrow → headline → subhead → primary CTA. Adjacent type-scale steps must contrast clearly (headline visibly dominant, not 10% larger).

RHYTHM — consistent vertical section padding from the spacing tokens (`var(--spacing-…)`); prose measures 60–75 characters; grids share one gap value; never ad-hoc pixel values where a token exists.

COLOR — roughly 60% background/surface, 30% secondary, 10% primary/accent. Alternate sections between `var(--color-background)` and `var(--color-surface-alt)`. Exactly ONE primary CTA per section, always on `var(--color-primary)`. Body text on background must keep WCAG-AA contrast.

DEPTH — flat walls of same-background sections read as unfinished. Use `var(--gradient-hero)` on the hero, `var(--gradient-subtle)` for washes, the `var(--shadow-sm…xl)` ramp for elevation (cards above sections, modals above cards).

TYPE — headings in `var(--font-heading)`, body in `var(--font-body)`; web fonts are self-hosted automatically, so pick real typefaces. Never mix a third family without cause.

IMAGERY — text-only pages read as drafts. Place real media via `find_media`/`generate_image`; until an image exists, a gradient/tinted block with an HTML comment naming the intended image beats an empty gap.

RESPONSIVE — author module CSS mobile-first; grids collapse to one column; tap targets ≥ 44px; test copy length at 375px width mentally before shipping.

ANTI-PATTERNS you never ship: default-blue links; unthemed system-font headings; center-aligning everything; three-equal-cards for every section; lorem ipsum; literal `{{placeholder}}` text.

SELF-REVIEW LOOP (#155) — after composing a page or making structural/styling changes (compose_page_from_spec, add_module_to_*, edit_module touching css/html): call `screenshot_page` for BOTH `desktop` and `mobile` viewports, critique the result against the sections above, fix what fails, and re-screenshot once. HARD CAP: two review rounds per turn. SKIP the loop for content-only edits (set_page_module_content, set_content_instance_values) and for admin-only surfaces. Never tell the operator a page is done without having looked at it.',
    '[]'::jsonb,
    '{"keywords":["build","create page","homepage","landing","hero","redesign","restyle","looks ugly","looks boring","make it beautiful","modern","design","layout","section","style"],"chipTrigger":true,"alwaysOn":false}'::jsonb,
    'active'
  );

-- compose-page learns the look-at-your-work step. Guarded: only when
-- the marker is absent (operator edits win; re-runs are no-ops).
UPDATE skills
SET body = body || '

6. AFTER composing (#155): call `screenshot_page` (desktop AND mobile), check the render against the design-quality bar (hierarchy, rhythm, color distribution, depth, responsiveness), fix what fails, re-screenshot once — max two rounds. Never present an unseen page.'
WHERE slug = 'compose-page'
  AND body NOT LIKE '%screenshot_page%';

COMMIT;
