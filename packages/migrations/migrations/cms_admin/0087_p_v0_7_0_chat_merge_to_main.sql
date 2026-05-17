-- SPDX-License-Identifier: MPL-2.0
--
-- v0.7.0 — chat.merge_to_main is the re-stageable variant of
-- chat.publish that powers /edit's Stage button. It re-emits branch
-- snapshots as main snapshots (same write path) but does NOT close
-- the chat session. Tag the merged snapshot with op_kind='chat.merge_to_main'
-- so the audit + undo views can distinguish a Stage cycle from a
-- formal Publish.

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
  'page_module_content.set',
  'structured_sets.set',
  'redirects.create',
  'redirects.update',
  'redirects.delete',
  'chat.stage',
  'chat.unstage',
  -- v0.7.0 — Stage button on /edit emits this on every merge cycle.
  'chat.merge_to_main',
  'unknown'
));
