-- SPDX-License-Identifier: MPL-2.0

-- v0.12.0 — separate content IDENTITY from page PLACEMENT.
--
-- Before this migration, page_module_content was keyed by
-- (page_id, block_name, position) — content was tied 1:1 to a
-- placement. Two placements of the same module could never share
-- content. Editing the contact info on /home didn't propagate to
-- /about even when it should.
--
-- After:
--   - content_instances IS the content row (id, module_id, values, version).
--   - page_modules.content_instance_id binds a placement to a content
--     row. Two placements can reference the same content_instances
--     row (sync_mode='synced'); editing it propagates to every
--     placement that binds to it.
--   - page_modules.sync_mode chooses between:
--       'synced'   → editing the placement edits every other
--                    placement that binds to the same instance.
--       'unsynced' → the placement holds a private instance
--                    (forked on demand from a shared one or minted
--                    fresh on first placement). Default for new
--                    placements per the v0.4.0 "page-local" baseline.
--
-- Migration is one-shot, idempotent, fail-loud per CLAUDE.md §2.
-- An orphan page_module_content row whose (page_id, block_name,
-- position) doesn't match any page_modules row aborts the migration
-- and surfaces the orphan id to the operator. Recovery: inspect
-- the row via audit_events; either rebind to a placement (`UPDATE
-- page_modules`) or hard-DELETE the stale row, then re-run the
-- migration.
--
-- The legacy page_module_content + page_module_content_snapshots
-- tables are NOT dropped here. They stay in place as read-only
-- history so a snapshots.revert_site against a pre-v0.12 snapshot
-- still applies cleanly. The pre-implementation audit confirmed
-- zero outside-package readers (no static-generator, no MCP, no
-- edge-router, no plugins). The drop-table cleanup is a separate
-- follow-up after a dogfood pass.

-- ─── 1. content_instances table ──────────────────────────────────────

CREATE TABLE content_instances (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id      uuid NOT NULL REFERENCES modules(id),
  -- Optional human-readable label (e.g. "primary-cta", "homepage-hero").
  -- Unique per (module_id, chat_branch_id) when not NULL so branched
  -- creates can carry the same slug as a main row temporarily.
  slug           text,
  display_name   text,
  -- jsonb shape mirrors page_module_content.content_values:
  --   { fieldName: value, ... }
  -- For module / module-list field kinds, value carries the nested
  -- reference shape: { moduleId, contentInstanceId } or an array
  -- thereof.
  "values"       jsonb NOT NULL DEFAULT '{}'::jsonb,
  version        bigint NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid REFERENCES actors(id),
  deleted_at     timestamptz,
  -- v0.9.0 branched-create pattern. A chat that creates a fresh
  -- content_instance tags it with chat_branch_id; the row is
  -- invisible to other chats until chat.merge_to_main clears the tag.
  chat_branch_id uuid
);

CREATE INDEX content_instances_module_idx
  ON content_instances (module_id)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX content_instances_module_slug_branched_unq
  ON content_instances (
    module_id,
    slug,
    COALESCE(chat_branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE slug IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX content_instances_chat_branch_idx
  ON content_instances (chat_branch_id)
  WHERE chat_branch_id IS NOT NULL;

--> statement-breakpoint

-- ─── 2. content_instance_snapshots table ─────────────────────────────

CREATE TABLE content_instance_snapshots (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_snapshot_id     uuid NOT NULL REFERENCES site_snapshots(id) ON DELETE CASCADE,
  content_instance_id  uuid NOT NULL REFERENCES content_instances(id) ON DELETE CASCADE,
  -- state jsonb = ContentInstanceState — see packages/admin-core/src/snapshots/state.ts
  state                jsonb NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX content_instance_snapshots_instance_idx
  ON content_instance_snapshots (content_instance_id, site_snapshot_id);
CREATE INDEX content_instance_snapshots_site_idx
  ON content_instance_snapshots (site_snapshot_id);

--> statement-breakpoint

-- ─── 3. page_modules.{content_instance_id,sync_mode} columns ─────────

-- Step 3a: add the columns nullable so existing rows survive.
ALTER TABLE page_modules
  ADD COLUMN content_instance_id uuid,
  ADD COLUMN sync_mode text NOT NULL DEFAULT 'unsynced';

ALTER TABLE page_modules
  ADD CONSTRAINT page_modules_sync_mode_check
  CHECK (sync_mode IN ('synced', 'unsynced'));

--> statement-breakpoint

-- ─── 4. Backfill — fail-loud on orphans ──────────────────────────────

-- Refuse to proceed if any page_module_content row doesn't match a
-- live page_modules placement. Per CLAUDE.md §2 (no fallbacks
-- pre-1.0), the loud error is the recovery signal.
DO $$
DECLARE
  orphan_count int;
BEGIN
  SELECT COUNT(*) INTO orphan_count
  FROM page_module_content pmc
  WHERE NOT EXISTS (
    SELECT 1 FROM page_modules pm
    WHERE pm.page_id = pmc.page_id
      AND pm.block_name = pmc.block_name
      AND pm.position = pmc.position
  );
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'migration 0093: % page_module_content row(s) reference no live page_modules placement. Inspect with: SELECT pmc.id, pmc.page_id, pmc.block_name, pmc.position FROM page_module_content pmc WHERE NOT EXISTS (SELECT 1 FROM page_modules pm WHERE pm.page_id = pmc.page_id AND pm.block_name = pmc.block_name AND pm.position = pmc.position); Then either rebind to a placement or DELETE the stale row, and re-run.', orphan_count;
  END IF;
END $$;

--> statement-breakpoint

-- 4a. Pre-mint a UUID per pmc row in a temp table so the (pmc → ci)
-- and (placement → ci) mappings are exact and unambiguous regardless
-- of timestamp coincidences.
CREATE TEMP TABLE _ci_backfill_pmc (
  pmc_id        uuid PRIMARY KEY,
  new_ci_id     uuid NOT NULL,
  module_id     uuid NOT NULL,
  page_id       uuid NOT NULL,
  block_name    text NOT NULL,
  "position"    integer NOT NULL,
  content_values jsonb NOT NULL,
  version       bigint NOT NULL,
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL
) ON COMMIT DROP;

INSERT INTO _ci_backfill_pmc
  (pmc_id, new_ci_id, module_id, page_id, block_name, "position", content_values, version, created_at, updated_at)
SELECT
  pmc.id, gen_random_uuid(), pm.module_id,
  pmc.page_id, pmc.block_name, pmc.position,
  pmc.content_values, pmc.version, pmc.created_at, pmc.updated_at
FROM page_module_content pmc
JOIN page_modules pm
  ON pm.page_id = pmc.page_id
 AND pm.block_name = pmc.block_name
 AND pm.position = pmc.position;

--> statement-breakpoint

-- 4b. Insert content_instances using the pre-minted IDs. Carries the
-- legacy content_values verbatim + the legacy version + the legacy
-- timestamps so the audit history is preserved.
INSERT INTO content_instances (id, module_id, "values", version, created_at, updated_at)
SELECT new_ci_id, module_id, content_values, version, created_at, updated_at
FROM _ci_backfill_pmc;

--> statement-breakpoint

-- 4c. Bind each existing page_modules placement to its newly-minted
-- content_instances row. sync_mode stays 'unsynced' (the column
-- default) so existing per-page behaviour is preserved bit-for-bit.
UPDATE page_modules pm
SET content_instance_id = b.new_ci_id
FROM _ci_backfill_pmc b
WHERE pm.page_id = b.page_id
  AND pm.block_name = b.block_name
  AND pm.position = b.position;

--> statement-breakpoint

-- 4d. Mint default content_instances rows for placements that have
-- NO matching page_module_content row (placement existed but had
-- never been edited via page_module_content.set). values={} so the
-- renderer falls back to the module's field defaults at preview time,
-- same behaviour as today's "no row" case.
CREATE TEMP TABLE _ci_backfill_default (
  page_id     uuid NOT NULL,
  block_name  text NOT NULL,
  "position"  integer NOT NULL,
  new_ci_id   uuid NOT NULL,
  module_id   uuid NOT NULL,
  PRIMARY KEY (page_id, block_name, "position")
) ON COMMIT DROP;

INSERT INTO _ci_backfill_default (page_id, block_name, "position", new_ci_id, module_id)
SELECT pm.page_id, pm.block_name, pm.position, gen_random_uuid(), pm.module_id
FROM page_modules pm
WHERE pm.content_instance_id IS NULL;

INSERT INTO content_instances (id, module_id, "values", created_at, updated_at)
SELECT new_ci_id, module_id, '{}'::jsonb, now(), now()
FROM _ci_backfill_default;

UPDATE page_modules pm
SET content_instance_id = d.new_ci_id
FROM _ci_backfill_default d
WHERE pm.page_id = d.page_id
  AND pm.block_name = d.block_name
  AND pm.position = d.position;

--> statement-breakpoint

-- 4d. Verify every placement now has a content_instance.
DO $$
DECLARE
  missing_count int;
BEGIN
  SELECT COUNT(*) INTO missing_count
  FROM page_modules
  WHERE content_instance_id IS NULL;
  IF missing_count > 0 THEN
    RAISE EXCEPTION 'migration 0093: % page_modules row(s) still have NULL content_instance_id after backfill. This is a backfill bug — abort and investigate.', missing_count;
  END IF;
END $$;

--> statement-breakpoint

-- ─── 5. Lock down the new column ─────────────────────────────────────

ALTER TABLE page_modules
  ALTER COLUMN content_instance_id SET NOT NULL;

ALTER TABLE page_modules
  ADD CONSTRAINT page_modules_content_instance_fk
  FOREIGN KEY (content_instance_id) REFERENCES content_instances(id) ON DELETE RESTRICT;

CREATE INDEX page_modules_content_instance_idx
  ON page_modules (content_instance_id);

--> statement-breakpoint

-- ─── 6. RLS — same authenticated-scope pattern as page_module_content ─

ALTER TABLE content_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_instances FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS content_instances_authenticated_scope ON content_instances;
CREATE POLICY content_instances_authenticated_scope ON content_instances
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

ALTER TABLE content_instance_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_instance_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS content_instance_snapshots_authenticated_scope ON content_instance_snapshots;
CREATE POLICY content_instance_snapshots_authenticated_scope ON content_instance_snapshots
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

--> statement-breakpoint

-- ─── 7. Extend op_kind / entity_kind CHECK constraints ───────────────

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
  'chat.merge_to_main',
  'chat.stage',
  'chat.unstage',
  'layout_modules.set',
  'page_module_content.set',
  'structured_sets.set',
  'redirects.create',
  'redirects.update',
  'redirects.delete',
  -- v0.12.0 — content_instances + placement binding op kinds.
  'content_instances.create',
  'content_instances.set_values',
  'content_instances.delete',
  'placement.set_content',
  'placement.fork_content',
  'unknown'
));

--> statement-breakpoint

ALTER TABLE chat_branch_publish_marks
  DROP CONSTRAINT IF EXISTS chat_branch_publish_marks_entity_kind_check;
ALTER TABLE chat_branch_publish_marks
  ADD CONSTRAINT chat_branch_publish_marks_entity_kind_check
  CHECK (entity_kind IN (
    'module',
    'template',
    'page',
    'pageLayout',
    'pageModuleContent',
    'layout',
    'structuredSet',
    'structuredSetOperation',
    'redirect',
    'theme',
    -- v0.12.0
    'contentInstance'
  ));

--> statement-breakpoint

ALTER TABLE chat_entity_locks
  DROP CONSTRAINT IF EXISTS chat_entity_locks_entity_kind_check;
ALTER TABLE chat_entity_locks
  ADD CONSTRAINT chat_entity_locks_entity_kind_check
  CHECK (entity_kind IN (
    'module',
    'template',
    'pageLayout',
    'layout',
    'structuredSet',
    'redirect',
    'page',
    'siteSettings',
    'siteDefaults',
    -- v0.12.0 — set_values on shared content needs cross-chat lock.
    'contentInstance'
  ));
