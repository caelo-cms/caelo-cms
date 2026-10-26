-- SPDX-License-Identifier: MPL-2.0
--
-- caelo:contract structured_sets and its snapshot / operation tables are dropped; the previous image reads them
--
-- 0354 — epic #1107 part B: structured sets are gone (lists replace them,
-- docs/lists.md). Their data is discarded on purpose — the only binding
-- that ever rendered a set was the `nav-menu-<slug>` module-slug
-- convention, and the menus that matter live in module fields, which 0353
-- converted to lists.
--
-- History stays readable: snapshot headers of `structured_sets.set` keep
-- their rows under op kind 'unknown' (their entity rows go with the
-- table). Locks, leases, stage marks, draft observations, takeover notes
-- and import-run links that named a set are removed.
--
-- The vocabularies follow: snapshot op kinds, lock / lease / stage-mark
-- entity kinds and import-run link entities drop the set kinds and gain
-- the list kinds; the domain-event outbox gains the list events
-- (docs/lists.md §9).

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

UPDATE site_snapshots SET op_kind = 'unknown' WHERE op_kind = 'structured_sets.set';
DELETE FROM chat_entity_locks WHERE entity_kind = 'structuredSet';
DELETE FROM entity_leases WHERE entity_kind = 'structuredSet';
DELETE FROM chat_branch_publish_marks WHERE entity_kind IN ('structuredSet', 'structuredSetOperation');
DELETE FROM draft_entity_observations WHERE entity_kind = 'structuredSet';
DELETE FROM chat_lock_takeovers WHERE entity_kind = 'structuredSet';
DELETE FROM import_run_links WHERE entity_kind = 'structured_set';

DROP TABLE structured_set_operations;
DROP TABLE structured_set_snapshots;
DROP TABLE structured_sets;

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
    'page_types.upsert_many', 'page_types.delete_many'
  ));

ALTER TABLE chat_entity_locks DROP CONSTRAINT IF EXISTS chat_entity_locks_entity_kind_check;
ALTER TABLE chat_entity_locks
  ADD CONSTRAINT chat_entity_locks_entity_kind_check
  CHECK (entity_kind IN (
    'module', 'template', 'pageLayout', 'layout', 'redirect', 'page', 'siteSettings',
    'siteDefaults', 'contentInstance', 'theme', 'pluginRow', 'listType', 'list', 'pageType'
  ));

ALTER TABLE entity_leases DROP CONSTRAINT IF EXISTS entity_leases_entity_kind_check;
ALTER TABLE entity_leases
  ADD CONSTRAINT entity_leases_entity_kind_check
  CHECK (entity_kind IN (
    'module', 'template', 'pageLayout', 'layout', 'redirect', 'page', 'siteSettings',
    'siteDefaults', 'contentInstance', 'theme', 'pluginRow', 'listType', 'list', 'pageType'
  ));

ALTER TABLE chat_branch_publish_marks
  DROP CONSTRAINT IF EXISTS chat_branch_publish_marks_entity_kind_check;
ALTER TABLE chat_branch_publish_marks
  ADD CONSTRAINT chat_branch_publish_marks_entity_kind_check
  CHECK (entity_kind IN (
    'module', 'template', 'page', 'pageLayout', 'pageModuleContent', 'layout', 'redirect',
    'theme', 'contentInstance', 'pluginRow', 'listType', 'list', 'pageType'
  ));

ALTER TABLE import_run_links DROP CONSTRAINT IF EXISTS import_run_links_entity_kind_check;
ALTER TABLE import_run_links
  ADD CONSTRAINT import_run_links_entity_kind_check
  CHECK (entity_kind IN ('content_instance', 'module', 'list'));

ALTER TABLE domain_events DROP CONSTRAINT IF EXISTS domain_events_kind_check;
ALTER TABLE domain_events
  ADD CONSTRAINT domain_events_kind_check
  CHECK (kind IN (
    'page.created', 'page.updated', 'page.deleted', 'page.published', 'module.updated',
    'list.items_changed', 'list_type.changed', 'list.deleted',
    'page.properties_changed', 'page.terms_changed'
  ));

COMMIT;
