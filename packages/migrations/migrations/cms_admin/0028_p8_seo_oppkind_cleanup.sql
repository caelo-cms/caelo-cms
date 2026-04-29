-- SPDX-License-Identifier: MPL-2.0
--
-- Phase 8 review pass — drop the speculative `pages_seo.*` entries
-- from the `site_snapshots.op_kind` CHECK that 0027_p8_seo.sql added.
--
-- 0027 listed `pages_seo.set`, `pages_seo.autofill`, `pages_seo.optimize`
-- in the constraint, but no code emits a snapshot with those op_kinds
-- and the TypeScript `SnapshotOpKind` type
-- (packages/admin-core/src/snapshots/emit.ts) doesn't include them.
-- The CHECK entries were dead constraint capacity. Same cleanup
-- pattern as 0025_p7_media_oppkind_cleanup.sql.
--
-- SEO ops record audit entries (with `recordAudit`) and the audit log
-- carries the diff history. Restoring SEO state across a revert is
-- intentionally not first-class — soft-delete on the page covers the
-- common case + the audit log captures what changed. If/when we ship
-- full SEO-snapshot semantics (new `pageSeo` SnapshotEntity kind +
-- `loadPageSeoState` + per-op emission), the constraint can re-add
-- the entries.

ALTER TABLE site_snapshots DROP CONSTRAINT IF EXISTS site_snapshots_op_kind_check;
ALTER TABLE site_snapshots ADD CONSTRAINT site_snapshots_op_kind_check CHECK (op_kind IN (
  'modules.create',
  'modules.update',
  'modules.delete',
  'templates.create',
  'templates.update',
  'templates.delete',
  'template_blocks.set',
  'pages.create',
  'pages.update',
  'pages.set_modules',
  'pages.delete',
  'snapshots.revert_site',
  'snapshots.revert_module',
  'snapshots.revert_template',
  'snapshots.revert_page',
  'chat.publish',
  'layout_modules.set',
  'unknown'
));
