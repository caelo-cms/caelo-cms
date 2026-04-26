-- SPDX-License-Identifier: MPL-2.0
--
-- P4 follow-up: structured op_kind on site_snapshots.
--
-- Until now snapshot rows carried an unstructured `description` string
-- (e.g. "modules.update slug=hero"). Querying or filtering by op kind
-- meant string matching with all the obvious bugs (slug=mod matched
-- mod-2). Promote the operation kind into a typed column with a CHECK
-- constraint that enumerates known ops. The display string stays as a
-- derived UI concern for i18n in P9.
--
-- Backfill maps existing rows by parsing the leading word of `description`.
-- Anything that doesn't match falls back to 'unknown', covered by the CHECK.

ALTER TABLE site_snapshots
  ADD COLUMN IF NOT EXISTS op_kind text NULL;

UPDATE site_snapshots
SET op_kind = CASE
  WHEN description LIKE 'modules.create%'        THEN 'modules.create'
  WHEN description LIKE 'modules.update%'        THEN 'modules.update'
  WHEN description LIKE 'modules.delete%'        THEN 'modules.delete'
  WHEN description LIKE 'templates.create%'      THEN 'templates.create'
  WHEN description LIKE 'templates.update%'      THEN 'templates.update'
  WHEN description LIKE 'templates.delete%'      THEN 'templates.delete'
  WHEN description LIKE 'template_blocks.set%'   THEN 'template_blocks.set'
  WHEN description LIKE 'pages.create%'          THEN 'pages.create'
  WHEN description LIKE 'pages.update%'          THEN 'pages.update'
  WHEN description LIKE 'pages.set_modules%'     THEN 'pages.set_modules'
  WHEN description LIKE 'pages.delete%'          THEN 'pages.delete'
  WHEN description LIKE 'revert site%'           THEN 'snapshots.revert_site'
  WHEN description LIKE 'revert module%'         THEN 'snapshots.revert_module'
  WHEN description LIKE 'revert template%'       THEN 'snapshots.revert_template'
  WHEN description LIKE 'revert page%'           THEN 'snapshots.revert_page'
  ELSE 'unknown'
END
WHERE op_kind IS NULL;

ALTER TABLE site_snapshots
  ALTER COLUMN op_kind SET NOT NULL;

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
    'unknown'
  ));

CREATE INDEX IF NOT EXISTS site_snapshots_op_kind_idx ON site_snapshots (op_kind);
