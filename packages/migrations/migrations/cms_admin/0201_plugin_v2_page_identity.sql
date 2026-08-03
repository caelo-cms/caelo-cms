-- SPDX-License-Identifier: MPL-2.0
--
-- 0201 — plugin-system v2 Phase A (#384): page identity without locale.
--
-- Epic #380 decision 5: slugs become globally unique; variant grouping
-- becomes explicit plugin data (#394), never slug-derived. The homepage
-- designation moves from the locales table (an i18n name tag on a core
-- routing concept) to site_defaults, where every other site-scoped
-- default lives. The locales table itself is dropped — locale
-- definitions return as plugin-owned cms_admin schema on the new
-- foundation (#389/#394).
--
-- Destructive by design (pre-1.0 ground rule: delete, don't migrate).
-- Multi-locale page rows cannot survive a global-slug world; installs
-- are single-locale in practice (locale management UI was removed in
-- 0199), so the only row transform is carrying the home designation over.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

-- 1. Re-home the homepage designation.
ALTER TABLE site_defaults
  ADD COLUMN IF NOT EXISTS home_page_id uuid NULL REFERENCES pages(id) ON DELETE SET NULL;
UPDATE site_defaults
  SET home_page_id = (SELECT home_page_id FROM locales WHERE is_default = true LIMIT 1)
  WHERE id = 1 AND home_page_id IS NULL;

-- 2. Domains lose their locale binding (FK must go before the table).
DELETE FROM domains WHERE kind = 'locale-public';
ALTER TABLE domains DROP COLUMN IF EXISTS locale_code;
ALTER TABLE domains DROP CONSTRAINT IF EXISTS domains_kind_check;
ALTER TABLE domains ADD CONSTRAINT domains_kind_check CHECK (kind IN ('admin', 'public'));

-- 3. The plugin bake cache loses its locale key (FK must go before the
--    table). Cached HTML is ephemeral — plugins re-bake on next deploy.
TRUNCATE static_bakes;
ALTER TABLE static_bakes DROP CONSTRAINT IF EXISTS static_bakes_pkey;
ALTER TABLE static_bakes DROP COLUMN IF EXISTS locale;
ALTER TABLE static_bakes ADD PRIMARY KEY (plugin_id, page_id);

-- 4. Comment archive loses its locale dimension (plugin data attaches
--    to a page, period; variant grouping is future plugin data).
DROP INDEX IF EXISTS comment_archive_page_locale_status_idx;
ALTER TABLE comment_archive DROP COLUMN IF EXISTS locale;
CREATE INDEX IF NOT EXISTS comment_archive_page_status_idx
  ON comment_archive (page_id, status, archived_at DESC);

-- 5. Drop the locales table.
DROP TABLE IF EXISTS locales;

-- 6. Page identity: global slug uniqueness, no translation tracking.
DROP INDEX IF EXISTS pages_slug_locale_branch_uidx;
DROP INDEX IF EXISTS pages_translation_status_idx;
ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_slug_locale_unique;
ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_translation_status_check;
ALTER TABLE pages
  DROP COLUMN IF EXISTS locale,
  DROP COLUMN IF EXISTS translation_status,
  DROP COLUMN IF EXISTS content_hash,
  DROP COLUMN IF EXISTS translated_from_hash;
-- Same shape as the old (slug, locale, branch) index minus the locale:
-- branch-scoped creates may shadow a main-branch slug until publish.
CREATE UNIQUE INDEX pages_slug_branch_uidx
  ON pages (slug, COALESCE(chat_branch_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE deleted_at IS NULL;

COMMIT;
