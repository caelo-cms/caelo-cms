-- SPDX-License-Identifier: MPL-2.0
-- v0.11.1 (issue #76) — rename the snapshot op_kind 'themes.import_dtcg'
-- to 'themes.import' to match the rename of the Query API op of the same
-- name. The op surface no longer parses DTCG itself (the AI tool runs
-- the auto-detect chain in TS-land and submits pre-parsed tokens), so
-- the snapshot label drops the format suffix.
--
-- v0.11.0 just landed and the old name shipped on dogfood installs only.
-- We accept BOTH values in the CHECK constraint so historical snapshot
-- rows that were written under the old name keep referencing-integrity;
-- new writes from v0.11.1+ use the new name exclusively.

ALTER TABLE site_snapshots
  DROP CONSTRAINT IF EXISTS site_snapshots_op_kind_check;
ALTER TABLE site_snapshots
  ADD CONSTRAINT site_snapshots_op_kind_check CHECK (op_kind IN (
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
    'chat.merge_to_main',
    'chat.stage',
    'chat.unstage',
    'layout_modules.set',
    'page_module_content.set',
    'structured_sets.set',
    'redirects.create',
    'redirects.update',
    'redirects.delete',
    'content_instances.create',
    'content_instances.set_values',
    'content_instances.delete',
    'placement.set_content',
    'placement.fork_content',
    'unknown',
    -- v0.11.0 (#45) — themes primitive.
    'themes.update_tokens',
    'themes.set_asset',
    'themes.duplicate',
    -- v0.11.1 (issue #76) — themes.import_dtcg renamed to themes.import.
    -- The old name stays accepted so v0.11.0 dogfood snapshots still
    -- satisfy the CHECK; new writes use the new name only.
    'themes.import_dtcg',
    'themes.import',
    'themes.activate'
  ));
