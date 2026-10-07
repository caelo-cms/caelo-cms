-- SPDX-License-Identifier: MPL-2.0
-- The site's document language: the `lang` attribute every rendered page
-- carries on `<html>` (preview and static build alike). Without it,
-- screen readers guess the pronunciation and Lighthouse flags
-- `html-has-lang` on every page.
--
-- Core stays locale-agnostic (epic #380): this is ONE site-wide value,
-- not a locale registry. When the `international-site` plugin is active
-- it contributes each page's own locale, which takes precedence for that
-- page; this column covers every page the plugin has no opinion about
-- (and every page on a site without the plugin).
--
-- NOT NULL with a stored default rather than nullable-with-a-render-time
-- fallback (CLAUDE.md §2 "No fallbacks pre-1.0"): existing installs are
-- seeded `en` here, visibly, and the AI / Owner change it through
-- `site_defaults.set_identity` (AI tool `set_site_identity`, admin panel
-- /security/seo). The CHECK mirrors `languageTagSchema` in
-- @caelo-cms/shared — a structural BCP 47 tag (`en`, `de`, `pt-BR`).
ALTER TABLE site_defaults
  ADD COLUMN site_language text NOT NULL DEFAULT 'en'
    CHECK (
      length(site_language) <= 35
      AND site_language ~ '^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$'
    );

COMMENT ON COLUMN site_defaults.site_language IS
  'BCP 47 document language rendered as <html lang> on every page a plugin does not assign its own locale to.';
