-- SPDX-License-Identifier: MPL-2.0
--
-- 0364 — move the stored skills onto the live tool names. Every singular
-- write tool with a bulk twin was retired (CLAUDE.md §11: singular is the
-- n=1 case of bulk), and reorder_module folded into move_module:
--
--   edit_module                 -> update_modules_many
--   set_page_module_content     -> set_page_module_content_many
--   set_content_instance_values -> set_content_instance_values_many
--   create_content_instance     -> create_content_instances
--   delete_content_instance     -> delete_content_instances
--   autofill_page_seo           -> autofill_page_seo_many
--   set_page_seo                -> set_page_seo_many
--   optimize_page_seo           -> bulk_optimize_seo
--   set_media_alt               -> set_media_alt_many
--   set_media_source            -> set_media_source_many
--   reorder_module              -> move_module (no toBlockName = same block)
--
-- The runtime alias table (admin-core ai/tools/retired-tools.ts) already
-- resolves old names in allowlists and calls, so nothing breaks without
-- this migration. It exists so the skills TEACH the live names: a skill
-- body that says "edit_module" makes the model call a tool it is never
-- offered, which costs a repair round-trip on every use.
--
-- Allowlists: every retired name maps to its target, order kept, duplicates
-- dropped (compose-page listed both edit_module and update_modules_many).
-- Plugin-owned skills are left alone — they are part of an approved
-- artifact (bound to its digest) and change only with a new plugin
-- version; proposals still awaiting the Owner keep the text the Owner is
-- asked to approve. The alias layer covers both at runtime.
--
-- Bodies: targeted replace() guarded by `LIKE` on the exact seeded phrase
-- (as 0302 / 0362): idempotent, and an Owner-edited text that no longer
-- carries the phrase stays as the Owner wrote it.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

-- ── allowlists ────────────────────────────────────────────────────────
WITH retired(old_name, new_name) AS (
  VALUES
    ('edit_module', 'update_modules_many'),
    ('set_page_module_content', 'set_page_module_content_many'),
    ('set_content_instance_values', 'set_content_instance_values_many'),
    ('create_content_instance', 'create_content_instances'),
    ('delete_content_instance', 'delete_content_instances'),
    ('autofill_page_seo', 'autofill_page_seo_many'),
    ('set_page_seo', 'set_page_seo_many'),
    ('optimize_page_seo', 'bulk_optimize_seo'),
    ('set_media_alt', 'set_media_alt_many'),
    ('set_media_source', 'set_media_source_many'),
    ('reorder_module', 'move_module')
)
UPDATE skills s
   SET allowlisted_tools = (
     SELECT jsonb_agg(to_jsonb(mapped.name) ORDER BY mapped.first_pos)
       FROM (
         SELECT COALESCE(r.new_name, t.name) AS name, min(t.pos) AS first_pos
           FROM jsonb_array_elements_text(s.allowlisted_tools) WITH ORDINALITY AS t(name, pos)
           LEFT JOIN retired r ON r.old_name = t.name
          GROUP BY 1
       ) AS mapped
   )
 WHERE s.plugin_id IS NULL
   AND s.status <> 'awaiting_activation'
   AND jsonb_typeof(s.allowlisted_tools) = 'array'
   AND s.allowlisted_tools ?| (SELECT array_agg(old_name) FROM retired);

-- ── bodies: the shared SURGICAL EDITS paragraph ───────────────────────
UPDATE skills
   SET body = replace(
     replace(
       body,
       'do NOT re-emit the whole body via edit_module.',
       'do NOT re-emit the whole body via update_modules_many.'
     ),
     'Reserve edit_module for a wholesale rewrite,',
     'Reserve update_modules_many for a wholesale rewrite,'
   )
 WHERE plugin_id IS NULL
   AND slug IN ('compose-page', 'design-quality', 'manage-module', 'scoped-edit', 'site-genesis')
   AND (body LIKE '%do NOT re-emit the whole body via edit_module.%'
        OR body LIKE '%Reserve edit_module for a wholesale rewrite,%');

-- ── bodies: per skill ─────────────────────────────────────────────────
UPDATE skills
   SET body = replace(
     body,
     'field values set via set_page_module_content (or the initial build_page content)',
     'field values set via set_page_module_content_many (or the initial build_page content)'
   )
 WHERE slug = 'compose-page'
   AND body LIKE '%field values set via set\_page\_module\_content (or the initial build\_page content)%';

UPDATE skills
   SET body = replace(
     body,
     'with add_module, remove_module_from, reorder_module, move_module.',
     'with add_module, remove_module_from, move_module (within its block: omit toBlockName, position up | down | index).'
   )
 WHERE slug = 'compose-page'
   AND body LIKE '%with add\_module, remove\_module\_from, reorder\_module, move\_module.%';

UPDATE skills
   SET body = replace(
     body,
     'Copy on THIS page only: set_page_module_content (per-placement content).',
     'Copy on THIS page only: set_page_module_content_many (per-placement content).'
   )
 WHERE slug = 'compose-page'
   AND body LIKE '%Copy on THIS page only: set\_page\_module\_content (per-placement content).%';

UPDATE skills
   SET body = replace(body, '`edit_module` for module scope;', '`update_modules_many` for module scope;')
 WHERE slug = 'design-preview'
   AND body LIKE '%`edit\_module` for module scope;%';

UPDATE skills
   SET body = replace(
     replace(
       body,
       '(build_page, add_module, edit_module touching css/html)',
       '(build_page, add_module, update_modules_many touching css/html)'
     ),
     '(set_page_module_content, set_content_instance_values)',
     '(set_page_module_content_many, set_content_instance_values_many)'
   )
 WHERE slug = 'design-quality'
   AND (body LIKE '%(build\_page, add\_module, edit\_module touching css/html)%'
        OR body LIKE '%(set\_page\_module\_content, set\_content\_instance\_values)%');

UPDATE skills
   SET body = replace(
     replace(
       replace(
         body,
         '(`edit_module` / `update_modules_many`)',
         '(`update_modules_many`)'
       ),
       'with `set_media_alt` / `set_media_alt_many`',
       'with `set_media_alt_many`'
     ),
     'with `set_page_seo` / `set_page_seo_many` (or `autofill_page_seo` before the first publish)',
     'with `set_page_seo_many` (or `autofill_page_seo_many` before the first publish)'
   )
 WHERE slug = 'fix-quality-findings'
   AND (body LIKE '%(`edit\_module` / `update\_modules\_many`)%'
        OR body LIKE '%with `set\_media\_alt` / `set\_media\_alt\_many`%'
        OR body LIKE '%with `set\_page\_seo` / `set\_page\_seo\_many` (or `autofill\_page\_seo` before the first publish)%');

UPDATE skills
   SET body = replace(body, 'set_media_alt writes it.', 'set_media_alt_many writes it (every image of a pass in one call).')
 WHERE slug = 'manage-media'
   AND body LIKE '%set\_media\_alt writes it.%';

UPDATE skills
   SET body = replace(
     replace(
       body,
       'REVISE a module (edit_module):',
       'REVISE a module (update_modules_many):'
     ),
     '(set_page_module_content on the page)',
     '(set_page_module_content_many on the page)'
   )
 WHERE slug = 'manage-module'
   AND (body LIKE '%REVISE a module (edit\_module):%'
        OR body LIKE '%(set\_page\_module\_content on the page)%');

UPDATE skills
   SET body = replace(
     replace(
       replace(
         replace(
           replace(
             body,
             'fill empty SEO fields with autofill_page_seo. Write the description from the page''s content (several pages: autofill_page_seo_many, one call);',
             'fill empty SEO fields with autofill_page_seo_many (every page in one call). Write the description from the page''s content;'
           ),
           'tells you to use optimize_page_seo instead.',
           'tells you to use bulk_optimize_seo instead.'
         ),
         'use optimize_page_seo WITH the user''s context',
         'use bulk_optimize_seo WITH the user''s context'
       ),
       'use set_page_seo (a direct field write, not inference).',
       'use set_page_seo_many (a direct field write, not inference).'
     ),
     'For many pages at once, bulk_optimize_seo runs the optimisation across a set in one call — prefer it over looping optimize_page_seo.',
     'bulk_optimize_seo takes every page of a pass in one call (`items`, one shared `context`) — never one call per page.'
   )
 WHERE slug = 'page-seo'
   AND (body LIKE '%with autofill\_page\_seo. Write the description%'
        OR body LIKE '%optimize\_page\_seo%'
        OR body LIKE '%use set\_page\_seo (a direct field write%');

UPDATE skills
   SET body = replace(
     body,
     '→ `set_page_module_content` (that placement''s fields).',
     '→ `set_page_module_content_many` (that placement''s fields).'
   )
 WHERE slug = 'scoped-edit'
   AND body LIKE '%→ `set\_page\_module\_content` (that placement''s fields).%';

UPDATE skills
   SET body = replace(
     body,
     'an empty build_page + add_module + set_page_module_content + create_content_instance calls',
     'an empty build_page + add_module + set_page_module_content_many + create_content_instances calls'
   )
 WHERE slug = 'site-migrate'
   AND body LIKE '%an empty build\_page + add\_module + set\_page\_module\_content + create\_content\_instance calls%';

UPDATE skills
   SET body = replace(body, 'on `add_module` / `edit_module`:', 'on `add_module` / `update_modules_many`:')
 WHERE slug = 'site-genesis'
   AND body LIKE '%on `add\_module` / `edit\_module`:%';

UPDATE skills
   SET body = replace(
     replace(
       replace(
         body,
         'Mint with create_content_instance (or create_content_instances for several at once — one transaction instead of N calls).',
         'Mint with create_content_instances (several rows in one call).'
       ),
       'set_page_module_content auto-mints',
       'set_page_module_content_many auto-mints'
     ),
     'then set_page_module_content applies',
     'then set_page_module_content_many applies'
   )
 WHERE slug = 'shared-content'
   AND (body LIKE '%Mint with create\_content\_instance (or%'
        OR body LIKE '%set\_page\_module\_content auto-mints%'
        OR body LIKE '%then set\_page\_module\_content applies%');

COMMIT;
