-- SPDX-License-Identifier: MPL-2.0
-- #551 — site_defaults.site_base_url carried DEFAULT 'http://localhost:8082'
-- (0027), and nothing ever replaced it on a real install: provisioning
-- knew the domain but never wrote it. Every production build then emitted
-- canonical, og:url, JSON-LD, sitemap.xml and the robots Sitemap: line
-- pointing at localhost.
--
-- The column now has no default and NULL means "not configured". Rows
-- still holding the old default never chose it, so they become NULL too.
-- The admin seeds the value from CAELO_SITE_URL (set by provisioning) at
-- boot, the Owner can set it under SEO settings, and the static generator
-- refuses to build without it (CLAUDE.md §2: no fallbacks pre-1.0).
ALTER TABLE site_defaults ALTER COLUMN site_base_url DROP DEFAULT;
ALTER TABLE site_defaults ALTER COLUMN site_base_url DROP NOT NULL;
UPDATE site_defaults SET site_base_url = NULL WHERE site_base_url = 'http://localhost:8082';
