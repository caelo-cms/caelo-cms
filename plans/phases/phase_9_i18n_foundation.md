# Phase 9 — i18n foundation + locale URL strategies

**Status:** stub — detail to be filled when this phase is picked up.
**Dependencies:** P3, P6, P8.
**Unblocks:** P10 (AI translation), P15 (per-locale domain provisioning).

## Goal (from master plan)
Add `locale` + `slug` unique constraint on pages plus `content_hash`, `translated_from_hash`, `last_changed_at`, `translation_status` fields. Locale config table supporting per-locale URL strategy (no-prefix default, subdirectory, subdomain, separate domain — mixed OK). **Locale config is admin-only** — Owners with `locale_admin` only; AI actors rejected at the Validator for every locale/URL-strategy op (§17.4). **UX simplification (UX-1):** *Default URL strategy is site-wide subdirectory*; subdomain and separate-domain are gated behind an explicit "Advanced URL routing" toggle in the security panel with clear SSL/CDN/hreflang implications and a linter that flags mixed configurations. Most users never leave the simple default. Static generator: emit one file per page per locale; locales without a published translation return clean 404. Auto hreflang generation. Built-in language selector module hydrated at deploy.

## End-to-end verification
`en` + `de` variants exist; `/about` + `/de/about` both publish; hreflang links match; missing `fr` is a clean 404; **AI locale-config writes rejected and logged**; **default subdirectory works out-of-the-box; Advanced URL routing toggle unlocks subdomain/domain with lint warnings on ambiguous configs**.

## To be detailed before execution
- Migration: add (locale, slug) unique constraint on pages; backfill existing rows with default locale.
- `locales` table: code, label, url_strategy enum (`none`, `subdirectory`, `subdomain`, `domain`), domain_or_subdomain string, is_default.
- **Advanced URL routing toggle:** `site_settings.advanced_url_routing` (bool, default false). When false, the url_strategy selector is fixed to `subdirectory` (with `none` for the default locale); subdomain/domain choices are hidden. When true, all strategies are selectable + a linter warns about mixed/ambiguous configurations.
- **Lint rules:** flag missing SSL config for subdomain/domain; flag hreflang conflicts when two strategies overlap; flag a default-locale that uses `none` alongside a subdirectory-prefixed sibling.
- **Locale config Query API ops** (`locales.create`, `locales.update`, `locales.delete`, `locales.set_url_strategy`) gated by actor type: human Owner with `locale_admin` permission only; AI actor type rejected before handler runs.
- Content hash algorithm: canonical JSON of content blocks → sha256.
- Trigger: source page write updates `content_hash` + `last_changed_at`; variants recompute `translation_status` based on `translated_from_hash` match.
- Static generator: URL resolver per locale; hreflang emitted with absolute URLs matching strategy.
- Clean 404: simply no file emitted; sitemap excludes the URL; `x-default` points to default locale.
- Language selector built-in module: placeholder hydrated at deploy with available locale URLs for the current page.
- Adversarial test: simulated AI actor calls each locale-config op → all must fail; audit log records the attempt.
