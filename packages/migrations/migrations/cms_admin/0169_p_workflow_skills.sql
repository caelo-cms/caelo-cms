-- SPDX-License-Identifier: MPL-2.0
--
-- 0169 — a skill per remaining authoring WORKFLOW (audit of the tool
-- catalogue, CLAUDE.md §2 "skills are the official way to teach AI new
-- behaviour").
--
-- 0168 covered the three core domains (pages / modules / menus). Walking
-- the ~95-tool catalogue, these workflows had tools but no skill to hand
-- the AI the right call shape + the CLAUDE.md invariant that governs them:
--
--   shared-content    content_instances: reuse vs fork vs mint (§1A/§11)
--   manage-media      images: find / generate / alt / variants
--   page-seo          SEO fill-once, then optimize-with-context (invariant)
--   manage-redirects  redirects: create / find / prune
--   theme-branding    theme tokens / assets / fonts / design manifest
--   templates-layouts page-type templates (direct) + layouts (Owner-gated)
--   import-page       bring ONE external URL into Caelo (single-page)
--
-- Whole-site design (site-genesis), whole-site migration (site-migrate),
-- design craft (design-quality), brand voice (brand-voice-guard) and the
-- subagent reviewers already exist and are NOT duplicated here.
--
-- Deliberately NOT seeded (gated / human-only decisions, low authoring
-- value — add later if the surface grows): locales/i18n (admin-only,
-- propose-gated), deploy (Ops, human-only), plugin authoring (Tier-2
-- Owner-activation). The AI reaches those tools via tool search when a
-- task needs them; no everyday skill is warranted yet.
--
-- Idempotent: ON CONFLICT (slug) DO NOTHING. All allowlist tool names are
-- validated live by the #301 skills tests.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

INSERT INTO skills (slug, display_name, description, body, allowlisted_tools, auto_engagement_hints, status)
VALUES
  ------------------------------------------------------------------------
  -- shared-content — reuse / fork / mint content instances.
  ------------------------------------------------------------------------
  (
    'shared-content',
    'Shared content across pages',
    'Decide when content is shared across pages versus page-local, and reuse / fork / mint content instances accordingly. Engaged when the user wants the same content in many places, or to change one page without affecting the others.',
    'You are deciding how content is SHARED across placements. Caelo separates a module (structure) from its content_instance (the values shown in a placement). Get this decision right so the operator never has to think in these primitives.

DECIDE first — check the `## Content Library` block:
- Same content should appear IDENTICALLY on N pages (site footer copyright, a brand banner, a repeated CTA)? Bind a SHARED instance. If a row with the matching purpose + module already exists, REUSE it — bind the placement via set_placement_content({syncMode: "synced"}). Editing that instance then propagates everywhere bound.
- Need a NEW shared row? Mint with create_content_instance (or create_content_instances for several at once — one transaction instead of N calls). A shared instance REQUIRES a one-line `purpose` (why it is shared) — it is the decision-support the next author reads.
- One-off content for a single page? Do NOT mint a shared row. set_page_module_content auto-mints a private (unsynced) instance for that placement — no shared semantics, no decision needed.
- Editing a synced placement but the change should hit ONLY this page? fork_placement_content detaches it into a fresh unsynced instance, then set_page_module_content applies the page-local edit. The other bound pages keep the shared value.

Never duplicate a shared row that already fits — duplicate shared instances defeat the point. When in doubt between reuse and fork, prefer reuse for content that is conceptually the same thing site-wide, fork for content that has diverged on purpose.',
    '["create_content_instance","create_content_instances","set_content_instance_values","get_content_instance","list_content_instances","set_placement_content","fork_placement_content","set_page_module_content"]'::jsonb,
    '{"keywords":["shared content","reuse the content","same on every","same across","everywhere","update everywhere","content instance","keep in sync","synced","fork this","only this page","just this page","unlink the content"],"chipTrigger":false,"alwaysOn":false}'::jsonb,
    'active'
  ),
  ------------------------------------------------------------------------
  -- manage-media — images and media assets.
  ------------------------------------------------------------------------
  (
    'manage-media',
    'Images & media',
    'Find, generate, and manage images and media — including alt text and responsive variants. Engaged when the user asks to add, replace, or generate a picture, or to fix alt text.',
    'You are placing or managing visual media.

1. Reuse first: call find_media to search the existing library before generating anything. Operators expect their uploaded photos to be used, not replaced by synthetic ones.
2. Generate only when nothing fits: generate_image mints a new asset from a prompt. Describe the subject concretely and match the site''s visual tone.
3. Alt text is not optional: every content image needs descriptive alt text for accessibility + SEO. set_media_alt writes it. Describe what the image SHOWS, not "image of"; decorative-only images take empty alt.
4. Responsive variants: regenerate_media_variants rebuilds the size/format set for an asset (use after replacing a source or when a variant is missing).
5. In module HTML, reference content imagery through an `image` field (so the operator can swap it per placement); reference brand assets (logo, favicon) through the reserved theme placeholders (`{{theme_logo_url}}` etc.), never a hard-coded src.

A text-only page reads as a draft — when a section clearly wants an image and none exists, place a real one rather than leaving a gap.',
    '["find_media","generate_image","set_media_alt","regenerate_media_variants"]'::jsonb,
    '{"keywords":["image","photo","picture","media","illustration","generate an image","replace the image","alt text","logo image","hero image","upload"],"chipTrigger":false,"alwaysOn":false}'::jsonb,
    'active'
  ),
  ------------------------------------------------------------------------
  -- page-seo — fill-once, then optimize-with-context.
  ------------------------------------------------------------------------
  (
    'page-seo',
    'Page SEO',
    'Fill and refine a page''s SEO fields (title, meta description, Open Graph, canonical). Engaged when the user asks about search engines, meta tags, or social sharing previews.',
    'You are working on a page''s SEO fields. Caelo''s rule is fill SEO once, then never silently overwrite it.

- BEFORE first publish, fill empty SEO fields with autofill_page_seo. It derives title / meta description / Open Graph from the page content. It fills ONCE — if the page was already autofilled it returns AlreadyAutofilled and tells you to use optimize_page_seo instead. Do not fight it.
- AFTER first publish (or to re-optimize), use optimize_page_seo WITH the user''s context (target keyword, audience, the angle they asked for). Content edits never silently rewrite SEO — re-optimisation is always explicit and user-driven.
- To set a specific field to an exact value the user dictated, use set_page_seo (a direct field write, not inference).
- For many pages at once, bulk_optimize_seo runs the optimisation across a set in one call — prefer it over looping optimize_page_seo.

SEO is structured fields only — never raw HTML into the page <head>. Keep titles under ~60 characters and meta descriptions under ~155; write for a human clicking a search result, not a keyword stuffer.',
    '["autofill_page_seo","optimize_page_seo","set_page_seo","bulk_optimize_seo","list_pages"]'::jsonb,
    '{"keywords":["seo","meta description","meta title","search engine","open graph","og image","social preview","canonical","search ranking","optimize for search","page title tag","serp"],"chipTrigger":false,"alwaysOn":false}'::jsonb,
    'active'
  ),
  ------------------------------------------------------------------------
  -- manage-redirects — redirects.
  ------------------------------------------------------------------------
  (
    'manage-redirects',
    'Redirects',
    'Create, find, and prune URL redirects. Engaged when the user mentions redirects, moved URLs, or old links that should forward.',
    'You are managing URL redirects (old path to new path, so links and search rankings survive a move).

- Find what exists first: find_redirects supports substring / glob matching (e.g. matches: "/old/*") so you can see and target existing rules without paginating.
- Create in bulk: bulk_create_redirects writes many rules in one transaction — prefer it over one-at-a-time even for a small handful.
- Renaming a page slug already creates its redirect automatically (that is the compose-page / page edit path) — you only mint redirects here for external moves or bulk clean-ups, not for slugs you just changed.
- Pruning: bulk_delete_redirects removes rules. Deleting a large substring match (roughly ten or more rows) is hard to predict — state exactly which rules will go and confirm the blast radius before a broad delete.

A redirect chain (A to B to C) is a smell — point A straight at C.',
    '["find_redirects","bulk_create_redirects","bulk_delete_redirects"]'::jsonb,
    '{"keywords":["redirect","redirects","301","forward the url","old url","moved the page","moved url","broken link","point the old"],"chipTrigger":false,"alwaysOn":false}'::jsonb,
    'active'
  ),
  ------------------------------------------------------------------------
  -- theme-branding — theme tokens / assets / fonts / manifest.
  ------------------------------------------------------------------------
  (
    'theme-branding',
    'Theme & branding',
    'Adjust the site theme — brand colors, typography, logo/favicon assets, and design tokens. Engaged when the user asks to change colors, fonts, or brand assets site-wide.',
    'You are shaping the site''s theme — the tokens and assets every module''s CSS references, so a change here lands site-wide.

- Read the current theme (get_theme) before editing; work from the existing token names.
- Colors, spacing, typography, radii, shadows are TOKENS: set_theme_tokens updates them (`--color-primary`, `--font-heading`, `--spacing-*`, …). Module CSS should reference `var(--token)`, never a hard-coded literal, so a token change re-skins everything at once.
- Brand assets (logo, dark logo, favicon, social share image) are bound with set_theme_asset — modules reference them via the reserved `{{theme_logo_url}}` / `{{theme_favicon_url}}` placeholders. An unbound slot fails loud (it shows in the editor''s missing-content surface); bind it rather than hard-coding a src.
- set_theme_meta edits theme name / metadata; set_design_manifest / get_design_manifest carry the higher-level design intent (mood, references) that guides craft.
- To experiment without touching the live theme, duplicate_theme first.

Fonts are self-hosted automatically, so choose real typefaces. Keep the palette disciplined — a primary, a small set of neutrals, and accents that clear WCAG-AA on their backgrounds.',
    '["get_theme","set_theme_tokens","set_theme_asset","set_theme_meta","set_design_manifest","get_design_manifest","list_themes","duplicate_theme"]'::jsonb,
    '{"keywords":["theme","brand color","brand colour","colors","colours","palette","font","fonts","typography","favicon","brand","design tokens","dark mode","logo colour"],"chipTrigger":false,"alwaysOn":false}'::jsonb,
    'active'
  ),
  ------------------------------------------------------------------------
  -- templates-layouts — page-type templates + Owner-gated layouts.
  ------------------------------------------------------------------------
  (
    'templates-layouts',
    'Templates & layouts',
    'Create and wire page-type templates and site layouts (chrome). Engaged when the user wants a new page type, a shared header/footer shell, or to move a page onto a different template.',
    'You are working on templates (a page TYPE''s block structure) and layouts (the site shell / chrome shared across page types).

TEMPLATES (direct):
- create_template defines a reusable block structure from HTML with `<caelo-slot name="X">` markers — each slot becomes a block a page fills with modules. Use it when a family of pages shares a shape (all blog posts, all product pages).
- Bind a template to a layout with set_template_layout; move an existing page onto a different template with repoint_page_template.
- Fill a template''s shared blocks (content on EVERY page of that type) with add_module (target = "template").

LAYOUTS (Owner-gated — two-step):
- A layout is the site chrome (the header/footer shell wrapping every page). create_layout only PROPOSES a layout — it queues a proposal the Owner approves at /security/layouts/pending. Do NOT claim the layout exists; tell the user you prepared it and they click Approve. After approval, bind templates via set_template_layout or fill its blocks via add_module (target = "layout").
- Only propose a new layout when no existing layout covers the chrome the user wants (e.g. a campaign shell with a banner and no footer). Otherwise reuse an existing layout.

Prefer reusing an existing template/layout over minting a new one — check list_templates / list_layouts first.',
    '["create_template","create_layout","set_template_layout","repoint_page_template","add_module","list_templates","list_layouts"]'::jsonb,
    '{"keywords":["template","layout","site shell","page type","block structure","new layout","header and footer everywhere","chrome","campaign layout","shared header"],"chipTrigger":false,"alwaysOn":false}'::jsonb,
    'active'
  ),
  ------------------------------------------------------------------------
  -- import-page — bring ONE external URL into Caelo.
  ------------------------------------------------------------------------
  (
    'import-page',
    'Import a single page',
    'Bring ONE existing external web page into Caelo as a draft. Engaged when the user points at a single URL to recreate — not a whole-site migration (that is site-migrate).',
    'You are importing ONE external page (not a whole site — a multi-page migration is the site-migrate skill).

Flow:
1. Look first: inspect_external_page (and screenshot_external_page) fetch the target URL so you can see its structure and design before committing.
2. Queue the import in LIST mode: propose_site_import with `urls: ["<the one URL>"]` fetches exactly that page (no crawl). This is Owner-gated — it QUEUES the run and waits for the Owner to approve the crawl. Tell the user to approve it; do not claim the page is imported yet.
3. Materialise after approval: once the run reads ready_for_review, compose_from_import turns the staged page into a draft page + modules (aggregating extracted theme tokens, creating/binding a template). If it reports "still crawling", that is expected timing — poll and call it again, do not treat it as an error.
4. Review the draft against the original: fix broken media (find_media / re-import assets), tighten the modules, and only then hand it to the operator.

Keep the imported page''s content faithful; restyle to the site theme only if the user asks.',
    '["inspect_external_page","screenshot_external_page","propose_site_import","compose_from_import","map_external_page_types","find_media","build_page"]'::jsonb,
    '{"keywords":["import this page","import a page","import a single page","recreate this url","recreate this page","copy this page from","bring in this url","import from the url"],"chipTrigger":false,"alwaysOn":false}'::jsonb,
    'active'
  )
ON CONFLICT (slug) DO NOTHING;

COMMIT;
