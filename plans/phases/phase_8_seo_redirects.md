# Phase 8 — SEO, Redirects, sitemap, robots

**Status:** stub — detail to be filled when this phase is picked up.
**Dependencies:** P3, P6, P7 (OG images).
**Unblocks:** P9 (locale-aware sitemap/hreflang extends this).

## Goal (from master plan)
Per-page SEO fields (meta title/description, OG title/description/image, canonical, robots directives) stored structurally — AI can set fields via Query API, cannot inject raw `<head>` HTML. Redirect manager table + admin UI. Static generator extensions: render `<head>` from SEO fields, emit `sitemap.xml`, `robots.txt` (staging always noindex), and a provider-appropriate redirect file. Nginx/Caddy formats ship here; Cloudflare/CloudFront/Azure redirect formats land in P15. **UX simplification (UX-7):** *AI auto-fills every SEO field from page content by default*; stored values are kept as a derived default until the user explicitly edits, at which point they become persisted *overrides* (visually marked "custom" with a reset-to-auto action). Editors never see a blank SEO form. All included in snapshots.

## End-to-end verification
**SEO fields pre-filled by AI auto-derivation; user edit marks field as "custom" with reset-to-auto**; `<head>` rendered; `sitemap.xml` + `robots.txt` + Nginx/Caddy redirect file generated; staging has noindex. Cloudflare/CloudFront/Azure formats deferred to P15.

## To be detailed before execution
- `page_seo` table: FK to page, meta_title, meta_description, og_title, og_description, og_image_media_id, canonical, robots. **Plus a single `ai_has_filled` boolean on the page (not per field)** — set the first time `seo-autofill` runs. No per-field override flags.
- **Fill-once rule** (enforced in the Query API write path): `seo-autofill` is only allowed to write SEO fields when `ai_has_filled = false`. Subsequent content edits never trigger SEO rewrites. After `ai_has_filled = true`, SEO changes only come from explicit user edits or the `seo-optimize` skill.
- **`seo-optimize` skill planner** (in P10A): accepts `{page_ids[], optimization_intent, user_context}` and produces a cross-page batch of proposed SEO updates; previewed as a single multi-page diff in the Publish pill so five pages confirm in one click.
- Admin UI: SEO form shows plain editable fields with a prominent "Ask AI to optimize" action that opens a prompt for context (e.g. paste keyword analysis).
- `redirects` table: source_path, destination_path, status_code (301/302), locale_scope (nullable until P9).
- Static generator: emit `<head>` from structured fields only (derived or overridden, same code path) — no AI-writable HTML anywhere near head.
- sitemap.xml: all published pages; hreflang extension deferred to P9.
- robots.txt: read from `site_settings`; staging env flag forces `Disallow: /`.
- Redirect file generator interface: pluggable `generate(redirects[], target) → file` — Nginx + Caddy implementations here; Cloudflare Pages / CloudFront Lambda@Edge / Azure Front Door in P15.
