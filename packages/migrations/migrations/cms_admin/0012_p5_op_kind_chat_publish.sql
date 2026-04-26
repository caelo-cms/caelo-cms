-- SPDX-License-Identifier: MPL-2.0
--
-- P5: extend the op_kind CHECK constraint to accept 'chat.publish' so
-- the snapshot emitted by `chat.publish` (merging branch snapshots into
-- main) can be tagged correctly. Drop + recreate the constraint
-- because Postgres has no `ALTER CHECK` syntax.

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
  'unknown'
));
