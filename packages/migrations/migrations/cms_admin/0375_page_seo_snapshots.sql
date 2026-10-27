-- SPDX-License-Identifier: MPL-2.0
--
-- 0375 — #1156: page SEO goes through Stage like the rest of the page.
--
-- A page's SEO fields ride its page snapshot (`page_snapshots.state.seo`):
-- in a chat a `pages_seo.*` write emits a pending page snapshot on the
-- chat's branch instead of writing `pages_seo`, and the Stage merge writes
-- the row. Outside a chat the write lands on `pages_seo` and a main
-- snapshot records it. No table changes: the snapshot tables, their RLS
-- and the draft machinery (stage, undo, takeover, revert) already cover
-- page snapshots.
--
-- The SEO write kinds join the snapshot op-kind vocabulary. 0027 added
-- three of them, but later rebuilds of the constraint dropped them (no
-- SEO write emitted a snapshot until now); `pages_seo.apply_translation`
-- (#591) is new. The rest of the list is 0354's, unchanged.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE site_snapshots DROP CONSTRAINT IF EXISTS site_snapshots_op_kind_check;
ALTER TABLE site_snapshots
  ADD CONSTRAINT site_snapshots_op_kind_check CHECK (op_kind IN (
    'modules.create', 'modules.update', 'modules.delete',
    'templates.create', 'templates.update', 'templates.delete', 'template_blocks.set',
    'pages.create', 'pages.update', 'pages.set_modules', 'pages.delete', 'pages.move_many',
    'snapshots.revert_site', 'snapshots.revert_module', 'snapshots.revert_template',
    'snapshots.revert_page',
    'chat.publish', 'chat.merge_to_main', 'chat.stage', 'chat.unstage',
    'layout_modules.set', 'page_module_content.set',
    'redirects.create', 'redirects.update', 'redirects.delete',
    'content_instances.create', 'content_instances.set_values', 'content_instances.delete',
    'placement.set_content', 'placement.fork_content', 'unknown',
    'themes.update_tokens', 'themes.set_asset', 'themes.duplicate', 'themes.import_dtcg',
    'themes.import', 'themes.activate', 'themes.update_meta',
    'plugin_storage.insert', 'plugin_storage.update', 'plugin_storage.delete',
    'chat.discard_branch', 'chat.adopt_change', 'chat.undo_changes',
    'links.migrate_to_references', 'links.revert_migration',
    'list_types.upsert_many', 'list_types.delete_many',
    'lists.upsert_many', 'lists.patch_items_many', 'lists.delete_many', 'lists.promote_local',
    'page_types.upsert_many', 'page_types.delete_many',
    'pages_seo.set', 'pages_seo.autofill', 'pages_seo.optimize', 'pages_seo.apply_translation'
  ));

COMMIT;
