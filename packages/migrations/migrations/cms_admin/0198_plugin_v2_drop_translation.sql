-- SPDX-License-Identifier: MPL-2.0
--
-- 0198 — plugin-system v2 Phase A (#381): drop the core translation feature.
--
-- Epic #380 ground rule: pre-1.0, delete don't migrate. Translation
-- (Mode 1/2, bulk jobs, glossary, style guide) is removed from core and
-- will be re-implemented inside the `international-site` plugin on the
-- new plugin foundation (#397). No data is carried over.
--
-- The `translations.write` permission row (seeded in 0002, granted to
-- the editor role) goes with it — permissions.ts no longer knows the
-- string, and a DB row code cannot name is exactly the kind of silent
-- drift the no-fallbacks rule exists to prevent.
--
-- pages.translation_status / content_hash / translated_from_hash and the
-- locales table survive until the page-identity cut (#384).

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

DROP TABLE IF EXISTS translation_job_units;
DROP TABLE IF EXISTS translation_jobs;
DROP TABLE IF EXISTS site_glossary;
DROP TABLE IF EXISTS site_style_guide;

DELETE FROM role_permissions
WHERE permission_id IN (SELECT id FROM permissions WHERE name = 'translations.write');
DELETE FROM permissions WHERE name = 'translations.write';

-- The editor role description (0002 seed) named translation management.
UPDATE roles
SET description = 'Create and edit content, manage modules — cannot deploy or change settings'
WHERE name = 'editor'
  AND description = 'Create and edit content, manage modules, manage translations — cannot deploy or change settings';

-- Registry row from installs that booted the deleted plugin. Fresh
-- installs never have it; carried-over DBs would otherwise keep an
-- 'active' plugin whose source_path no longer exists.
-- (schema_migrations cascades; actors.plugin_id is ON DELETE SET NULL.)
DELETE FROM plugins WHERE slug = 'translation';

COMMIT;
