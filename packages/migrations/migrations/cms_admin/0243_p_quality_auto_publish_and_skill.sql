-- SPDX-License-Identifier: MPL-2.0
--
-- 0243 — issue #553 PR 3.
--
-- 1. Automatic redeploys go through the quality gate. A redeploy whose
--    changes can affect rendering is Staged, audited, and published only
--    when the gate is open; the audit run remembers that it was queued for
--    such an automatic publish and how that ended:
--      auto_publish          the run was queued by the automatic redeploy;
--      auto_publish_outcome  'published' | 'blocked' once settled;
--      auto_publish_message  the gate message when it was blocked.
--
-- 2. The `fix-quality-findings` skill: the playbook the AI follows when a
--    quality check of the staged build found problems (CLAUDE.md §2: new AI
--    behaviour ships as a skill). Seeded ACTIVE like the other core
--    authoring skills (0168, 0185). Idempotent.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE quality_audit_runs
  ADD COLUMN auto_publish boolean NOT NULL DEFAULT false,
  ADD COLUMN auto_publish_outcome text NULL
    CHECK (auto_publish_outcome IS NULL OR auto_publish_outcome IN ('published', 'blocked')),
  ADD COLUMN auto_publish_message text NULL,
  ADD CONSTRAINT quality_audit_runs_auto_publish_shape CHECK (
    (auto_publish OR auto_publish_outcome IS NULL)
    AND ((auto_publish_outcome = 'blocked') = (auto_publish_message IS NOT NULL))
  );

INSERT INTO skills (slug, display_name, description, body, allowlisted_tools, auto_engagement_hints, status)
VALUES (
  'fix-quality-findings',
  'Fix quality findings',
  'How to fix what the Lighthouse quality check of the staged build found (Accessibility, Best Practices, SEO, Performance) so Publish live opens again. Engaged when a quality check reports problems or the operator asks about quality, Lighthouse, accessibility or a blocked Publish.',
  $body$You are fixing problems the QUALITY CHECK found on the staged build. Publish live stays blocked until every problem is fixed or an editor accepted it on its page.

1. READ THE FINDINGS FIRST. Call `get_quality_audit` (no arguments = this chat's newest check). Every problem names its page path and a Lighthouse audit id (`image-alt`, `color-contrast`, `meta-description`, …) or a category score below the page's baseline. Fix by audit id, page by page. Never guess from the category name alone.

2. FIX AT THE SOURCE, ONCE. Most findings come from a module or the theme that many pages share — fix the module (`edit_module` / `update_modules_many`) or the theme tokens (`set_theme_tokens`), not each page. Check `list_modules` usage before editing a shared module.

3. THE USUAL FIXES:
   - `image-alt`: give every content image a real description with `set_media_alt` / `set_media_alt_many` (or the module's alt field); purely decorative images get `alt=""` in the module HTML.
   - `color-contrast`: raise the contrast in the theme tokens (text vs. background, at least 4.5:1, 3:1 for large text) — never by hard-coding colours in one module.
   - `label`, `button-name`, `link-name`: every form control needs a `<label>`, every icon-only button/link an accessible name (`aria-label`).
   - `heading-order`, `landmark-*`, `region`: one `<h1>` per page, no skipped levels, content inside `<main>`, chrome in `<header>`/`<footer>`/`<nav>`.
   - `meta-description`, `document-title`: write them with `set_page_seo` / `set_page_seo_many` (or `autofill_page_seo` before the first publish). Canonical problems usually mean the site base URL is wrong — check `get_site_seo`.
   - Performance (`render-blocking-*`, `unused-*`, `font-display`, `uses-responsive-images`, `offscreen-images`, `unsized-images`): load images through the media variants with width/height and `loading="lazy"` below the fold, keep module CSS/JS small and non-blocking, use the theme's self-hosted fonts.
   - `errors-in-console`: a script in a module throws or a resource 404s — fix the module's JS or the broken URL.

4. RE-CHECK THROUGH A STAGE. Fixes reach the audited build only through a new Stage: when you are done, tell the operator in one sentence what you fixed and ask them to Stage again (if the fix changed nothing on the chat branch — SEO texts are written live — they use "Stage again" in the toolbar). `check_stage_audit` tells you whether the next Stage will be audited. You have at most TWO automatic fix rounds; after that, stop changing the site for these findings.

5. WHAT YOU CANNOT OR SHOULD NOT FIX, ASK ABOUT. An intended design choice (a brand colour the editor wants), a third-party embed, or a score the page cannot reach — propose an acceptance with `accept_quality_findings` (page path + audit id or category, one plain-language reason, everything of one decision in ONE call). The editor decides on the card. An acceptance applies only to that page. Check `list_quality_acceptances` first; never ask twice.

6. A FAILED CHECK IS NOT A FINDING. When the check itself failed (no result: timeout, browser, staging unreachable), retry it with `retry_quality_audit`. Only if the editor explicitly wants to publish without a result, use `publish_despite_failed_audit` — never for real problems, never on your own initiative.

7. TELL THE OPERATOR IN PLAIN WORDS. "The images on /about had no descriptions — added them" rather than audit ids. `get_publish_gate` says whether Publish live is open.$body$,
  '["get_quality_audit","check_stage_audit","get_publish_gate","list_quality_audits","list_quality_acceptances","accept_quality_findings","retry_quality_audit","edit_module","update_modules_many","list_modules","set_theme_tokens","get_theme","set_media_alt","set_media_alt_many","find_media","set_page_seo","set_page_seo_many","autofill_page_seo","get_site_seo","inspect_built_page","query_page_html"]'::jsonb,
  '{"keywords":["quality check","quality audit","lighthouse","accessibility","barrierefreiheit","contrast","alt text","meta description","core web vitals","pagespeed","publish blocked","publish live is blocked","image-alt","color-contrast","fix round"],"chipTrigger":false,"alwaysOn":false}'::jsonb,
  'active'
)
ON CONFLICT (slug) DO NOTHING;

COMMIT;
