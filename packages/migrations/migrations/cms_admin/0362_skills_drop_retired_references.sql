-- SPDX-License-Identifier: MPL-2.0
--
-- 0362 — bring the core skills up to the current product. They still
-- pointed the AI at surfaces that no longer exist:
--   - system-prompt blocks retired when the prompt became fully static
--     (`## Content Library`, `## Modules`, `## Site identity`,
--     `## Design system`, the Site defaults / Layouts context blocks):
--     list_content_instances, list_modules, get_site_defaults, get_theme
--     and the site status note on the user message carry that state now;
--   - `add_module_to_page` / `add_module_to_*` / `create_page`, tool names
--     replaced by add_module and build_page;
--   - the /settings/layouts/pending round-trip: a layout proposal is
--     approved on its card in the chat;
--   - core locale URL strategies: i18n is plugin-owned (epic #380);
--   - `isDeleted` flags no tool reports.
-- scoped-edit also routed text changes to edit_module, which rewrites the
-- module on every page; a chipped element's text is that placement's
-- content, so it now goes to set_page_module_content, which the skill
-- preloads.
--
-- Targeted replace() guarded by `LIKE` on the exact old phrase (as 0302):
-- idempotent, and an Owner-edited text that no longer carries it stays.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

UPDATE skills
   SET body = replace(
     body,
     'DECIDE first — check the `## Content Library` block:',
     'DECIDE first — check list_content_instances (each shared row''s purpose, module and placement count):'
   )
 WHERE slug = 'shared-content'
   AND body LIKE '%DECIDE first — check the `## Content Library` block:%';

UPDATE skills
   SET body = replace(
     body,
     'check list_modules / the ## Modules block for a module',
     'check list_modules for a module'
   )
 WHERE slug = 'manage-module'
   AND body LIKE '%check list_modules / the ## Modules block for a module%';

UPDATE skills
   SET body = replace(
     body,
     'if `## Site identity` lacks a design brief',
     'if get_site_defaults shows no design brief'
   )
 WHERE slug = 'site-genesis'
   AND body LIKE '%if `## Site identity` lacks a design brief%';

UPDATE skills
   SET body = replace(body, '`add_module_to_page` / `edit_module`', '`add_module` / `edit_module`')
 WHERE slug = 'site-genesis'
   AND body LIKE '%`add_module_to_page` / `edit_module`%';

UPDATE skills
   SET body = replace(
     body,
     'the `## Design system` block for the site''s token roles and patterns',
     '`get_theme` for the site''s tokens and their roles'
   )
 WHERE slug = 'design-preview'
   AND body LIKE '%the `## Design system` block for the site''s token roles and patterns%';

UPDATE skills
   SET body = replace(
     body,
     '(build_page, add_module_to_*, edit_module touching css/html)',
     '(build_page, add_module, edit_module touching css/html)'
   )
 WHERE slug = 'design-quality'
   AND body LIKE '%(build_page, add_module\_to\_*, edit_module touching css/html)%';

UPDATE skills
   SET body = replace(
     body,
     '(see the Site defaults / Layouts context blocks)',
     '(the site status note says ''Layout: needs setup'' or ''Template: needs setup'')'
   )
 WHERE slug = 'compose-page'
   AND body LIKE '%(see the Site defaults / Layouts context blocks)%';

UPDATE skills
   SET body = replace(
     body,
     'When a tool returns "Queued proposal <uuid>: <tool-name> — needs Owner approval (...)" the action is NOT applied yet.',
     'When a tool result starts with "Queued proposal <uuid>:" the action is NOT applied yet.'
   )
 WHERE slug = 'compose-page'
   AND body LIKE '%When a tool returns "Queued proposal <uuid>: <tool-name> — needs Owner approval (...)" the action is NOT applied yet.%';

UPDATE skills
   SET body = replace(
     body,
     'Owner clicks Approve at /settings/layouts/pending.',
     'the operator approves it on the proposal card in the chat.'
   )
 WHERE slug = 'bootstrap-site'
   AND body LIKE '%Owner clicks Approve at /settings/layouts/pending.%';

UPDATE skills
   SET body = replace(
     body,
     'it queues a proposal the Owner approves at /settings/layouts/pending.',
     'it queues a proposal the Owner approves on its card in the chat.'
   )
 WHERE slug = 'templates-layouts'
   AND body LIKE '%it queues a proposal the Owner approves at /settings/layouts/pending.%';

UPDATE skills
   SET body = replace(
     body,
     'is the LOCALE URL-STRATEGY (admin-gated)',
     'comes from the international-site plugin''s URL strategy (Owner-approved)'
   )
 WHERE slug = 'homepage'
   AND body LIKE '%is the LOCALE URL-STRATEGY (admin-gated)%';

UPDATE skills
   SET body = replace(
     body,
     'A locale prefix is the URL-strategy (admin-gated)',
     'A locale prefix comes from the international-site plugin''s URL strategy (Owner-approved)'
   )
 WHERE slug = 'site-migrate'
   AND body LIKE '%A locale prefix is the URL-strategy (admin-gated)%';

UPDATE skills
   SET body = replace(
     body,
     'a chain of create_page + add_module_to_page + set_page_module_content + create_content_instance calls',
     'a chain of an empty build_page + add_module + set_page_module_content + create_content_instance calls'
   )
 WHERE slug = 'site-migrate'
   AND body LIKE '%a chain of create_page + add_module_to_page + set_page_module_content + create_content_instance calls%';

UPDATE skills
   SET body = replace(body, ' and any soft-deleted modules surfaced as `isDeleted` flags', '')
 WHERE slug = 'explain-page'
   AND body LIKE '% and any soft-deleted modules surfaced as `isDeleted` flags%';

UPDATE skills
   SET body = replace(
     body,
     '3. Use `edit_module` to change content fields. Never use `add_module_to_page` or any structural tool unless the user explicitly asks for structural change.',
     '3. Text or images the chipped element shows on this page → `set_page_module_content` (that placement''s fields). Its markup or styling → `read_content` + `edit_content`, which changes the module on every page that uses it. Never add, move or remove modules unless the user explicitly asks for a structural change.'
   ),
       allowlisted_tools = CASE
         WHEN allowlisted_tools ? 'set_page_module_content' THEN allowlisted_tools
         ELSE allowlisted_tools || '["set_page_module_content"]'::jsonb
       END
 WHERE slug = 'scoped-edit'
   AND body LIKE '%3. Use `edit_module` to change content fields. Never use `add\_module\_to\_page` or any structural tool unless the user explicitly asks for structural change.%';

COMMIT;
