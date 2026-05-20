-- SPDX-License-Identifier: MPL-2.0
--
-- v0.10.21 — Seed two empty default nav-menu rows so a fresh install
-- starts with the structured-data pattern visible to the AI.
--
-- Pre-v0.10.21 the structured_sets table was empty on fresh installs.
-- The v0.10.20 system-prompt block returned `undefined` for an empty
-- list, so the AI didn't even know nav-menus existed as a concept on
-- the site — it fell back to editing the header module's HTML directly
-- when asked to "update the navigation."
--
-- Seeding empty header-main + footer-main rows gives the AI:
--   1. A visible row in the `## Structured-data sets you can edit`
--      block (with v0.10.20's nav-menu item inlining showing
--      "0 items" — an invitation to populate them).
--   2. A clear naming convention (`header-main`, `footer-main`) the
--      AI can extend (`utility-main`, `mobile-main`, etc.).
--   3. A canonical rendering convention paired with module slugs
--      `nav-menu-header-main` / `nav-menu-footer-main` documented in
--      the v0.10.21 system-prompt primer.
--
-- `display_name` is human-facing — surfaces in the structured-sets
-- admin UI when operators inspect their menus. Items default to '[]'.
--
-- ON CONFLICT (kind, slug) DO NOTHING — idempotent on existing
-- installs and re-runs. Operators who already have menus by these
-- slugs keep what they have; everyone else gets the defaults.
INSERT INTO structured_sets (kind, slug, display_name, items)
VALUES
  ('nav-menu', 'header-main', 'Header menu', '[]'::jsonb),
  ('nav-menu', 'footer-main', 'Footer menu', '[]'::jsonb)
ON CONFLICT (kind, slug) DO NOTHING;
