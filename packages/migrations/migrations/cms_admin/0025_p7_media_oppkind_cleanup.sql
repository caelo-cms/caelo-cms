-- SPDX-License-Identifier: MPL-2.0
--
-- Phase 7 review pass — drop the speculative `media.*` entries from
-- the `site_snapshots.op_kind` CHECK that 0024_p7_media.sql added.
--
-- 0024 listed `media.upload`, `media.update_alt`, `media.delete` in
-- the constraint, but no code ever emits a snapshot with those
-- op_kinds and the TypeScript `SnapshotOpKind` type
-- (packages/admin-core/src/snapshots/emit.ts) doesn't include them.
-- The CHECK entries were dead constraint capacity.
--
-- Media ops record audit entries but do NOT emit snapshots. Soft-
-- delete is reversible from the audit log; restoring a hard-deleted
-- asset would also need the storage blob, which is out of scope for
-- a snapshot revert. If/when we ship full media-snapshot semantics
-- (new `media` SnapshotEntity kind + `loadMediaAssetState` +
-- per-op emission), the constraint can re-add the entries.

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
