-- SPDX-License-Identifier: MPL-2.0
--
-- 0346 — issue #1028: the boot-time link migration runs again when its
-- conversion rules change.
--
-- The admin runs `links.migrate_to_references` once per install at boot
-- (0326, apps/admin hooks.server.ts). Until #1028 a content write whose only
-- internal links sat in rich text skipped write-time canonicalisation, so
-- installs that ran the migration before the fix still hold literal paths
-- written since. "Once per install" becomes "once per revision of the
-- migration": every run records the revision of the conversion it ran
-- (`LINK_MIGRATION_REVISION` in admin-core ops/links.ts), and the boot run
-- converts again while no applied run of the current revision exists. Rows
-- written before this column existed ran revision 1.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE link_migration_runs
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;

COMMIT;
