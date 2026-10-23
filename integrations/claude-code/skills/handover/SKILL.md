---
name: handover
description: Move a website built or prototyped with Claude Code (HTML/CSS, a static site, a Tailwind project, a design prototype) or an existing live site into Caelo CMS, so editors can maintain it safely afterwards. Use when the user wants to "put this site into Caelo", "hand the site over", migrate a site to Caelo, or turn a prototype into an editable Caelo site.
---

# Hand a site over to Caelo

Goal: the design and content end up as Caelo's own building blocks (one theme with tokens, layouts, templates, modules with named fields, pages), so people can edit the site later without breaking it. Run the `edit-site` loop around everything here: open a session, read the context, stage, and leave Publish live to the user.

First call `caelo_open_session` and `caelo_get_context`. When the site already has content or other open work, call `start_isolated_branch` before the first change, so the handover does not mix with it. Check the skills index in the context: when it lists `site-genesis` or `site-migrate`, load the matching one with `load_skill` and follow it; it describes the current flow on this install in more detail than this file.

## Pick the path

| The user has | Path |
|---|---|
| A finished design as HTML (prototype, static site, export) | A. Bring your own design |
| A larger site, or a design system (tokens, components) to keep exact | B. Build the system step by step |
| A site that is already live at a URL | C. Import the live site |

Ask if unclear. Paths can combine: C for content, A or B for the new design.

## A. Bring your own design

1. Merge the prototype into ONE self-contained HTML page: all CSS inline in `<style>`, real copy, no external scripts (scripts are stripped; tell the user if the design relied on them). The tool accepts up to 300,000 characters.
2. Save it with `save_design_draft` (`scope: "site"`, `sourceKind: "byod_html"`, a short `direction` and `rationale`).
3. Show the user what was saved and let them confirm it. Call `select_design_draft` only after they explicitly pick it.
4. Use `inspect_design_draft` as the fact base: derive the theme from the draft's exact palette and typefaces, and re-express its sections as modules and templates. Do not invent a different design.
5. Compare the result with the prototype page by page (`screenshot_page`) and fix differences.

## B. Build the system step by step

1. **Theme.** Read the current theme first (`list_themes`, `get_theme`). If the project has tokens (CSS custom properties, Tailwind 4 theme, shadcn variables, DTCG JSON), `import_theme` detects these formats; otherwise set them with `set_theme_tokens`. Keep a short mapping (project token -> Caelo token) in the project. Fonts: `find_fonts` / `acquire_font`, so they are served from the site.
2. **Layout and templates.** Header, footer and navigation once in a layout; one template per page type. On a fresh install `bootstrap_site_scaffold` creates the first layout, template and defaults. Creating a layout and changing or deleting layouts and templates are approval-gated: the user approves the card in Caelo.
3. **Modules.** One module per building block with semantic fields (headline, text, link, image, alt text). Avoid modules that are one big HTML field.
4. **Media.** Local files: `caelo_upload_images` (up to 4 per call, 5 MiB each). Images on a live site: `import_media_from_urls` with meaningful names (the name becomes the public URL).
5. **Pages.** `build_page` per page with the full module list, filled with the real copy. Then SEO fields and redirects for changed URLs.

## C. Import the live site

Use `inspect_external_page` to understand the site, then `propose_site_import` to queue the crawl. It is approval-gated: the crawl only runs after the user approves it in Caelo. Then follow the `site-migrate` skill for page review, rebuild, media and redirects.

## Finish

Stage, fix every quality finding (`get_quality_audit`), and hand over as in `edit-site`: the user reviews staging and clicks Publish live. Afterwards editors change content through the module fields or Caelo's built-in assistant; keep design decisions in the project (for example a `DESIGN.md`) for future AI sessions.

For the steps before this one (brand, personas, structure, moodboard, design directions, tested prototype), the free skill package https://github.com/caelo-cms/website-design-skills (MIT) walks through them and ends with this handover.
