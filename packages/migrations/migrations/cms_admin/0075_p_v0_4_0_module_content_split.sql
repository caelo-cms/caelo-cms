-- SPDX-License-Identifier: MPL-2.0

-- v0.4.0 — separate module CODE from page CONTENT.
--
-- Before this migration, modules.html stored literal content
-- (e.g. <h1>Welcome</h1>) and chat-branch overlays applied to
-- the CODE itself — which meant two parallel chats editing the
-- same module silently diverged across branches, and module
-- edits were "global by accident" because the html column was
-- replaced wholesale.
--
-- After:
--   - modules.html is a TEMPLATE referencing fields via `{{name}}`
--   - modules.fields declares the field schema (name, kind, default)
--   - page_module_content holds per-placement content values
--   - page_module_content_snapshots carries branch overlays + revert history
--
-- Module code edits stay global + immediate (no branch overlay).
-- Page content edits are branch-isolated per chat until publish.

-- 1. Modules become templates: declare their field schema.
ALTER TABLE modules
  ADD COLUMN fields jsonb NOT NULL DEFAULT '[]'::jsonb;
-- `fields` is an ordered array of:
--   { name: "headline", kind: "text", label: "Headline", default: "" }
-- kind ∈ ('text','richtext','url','image','number','boolean','link').
-- Validated at the Query API zod boundary; no DB constraint here
-- because the array shape evolves with the kind enum over time.

--> statement-breakpoint

-- 2. Per-placement content store. Keyed identically to page_modules
-- so the join is a 4-column equality + an index on (page_id) does
-- the heavy lifting at preview time.
CREATE TABLE page_module_content (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id         uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  block_name      text NOT NULL,
  position        integer NOT NULL,
  content_values  jsonb NOT NULL DEFAULT '{}'::jsonb,
  version         bigint NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (page_id, block_name, position)
);

CREATE INDEX page_module_content_page_idx ON page_module_content (page_id);

--> statement-breakpoint

-- 3. Snapshot table for branch overlays + global revert history.
-- Mirrors module_snapshots shape; site_snapshots already carries
-- chat_branch_id so the existing publish-merge logic only needs
-- to know about the new entity kind.
CREATE TABLE page_module_content_snapshots (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_snapshot_id  uuid NOT NULL REFERENCES site_snapshots(id) ON DELETE CASCADE,
  page_module_content_id uuid NOT NULL REFERENCES page_module_content(id) ON DELETE CASCADE,
  page_id           uuid NOT NULL,
  block_name        text NOT NULL,
  position          integer NOT NULL,
  state             jsonb NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX page_module_content_snapshots_content_idx
  ON page_module_content_snapshots (page_module_content_id, site_snapshot_id);
CREATE INDEX page_module_content_snapshots_site_idx
  ON page_module_content_snapshots (site_snapshot_id);
CREATE INDEX page_module_content_snapshots_page_idx
  ON page_module_content_snapshots (page_id, site_snapshot_id);

--> statement-breakpoint

-- 4. RLS — same authenticated-scope pattern as page_modules + module_snapshots.
ALTER TABLE page_module_content ENABLE ROW LEVEL SECURITY;
ALTER TABLE page_module_content FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS page_module_content_authenticated_scope ON page_module_content;
CREATE POLICY page_module_content_authenticated_scope ON page_module_content
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

ALTER TABLE page_module_content_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE page_module_content_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS page_module_content_snapshots_authenticated_scope ON page_module_content_snapshots;
CREATE POLICY page_module_content_snapshots_authenticated_scope ON page_module_content_snapshots
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

--> statement-breakpoint

-- 5. Extend chat_branch_publish_marks.entity_kind CHECK so the new kind
--    can be marked as published. Original constraint added in 0016.
ALTER TABLE chat_branch_publish_marks
  DROP CONSTRAINT IF EXISTS chat_branch_publish_marks_entity_kind_check;
ALTER TABLE chat_branch_publish_marks
  ADD CONSTRAINT chat_branch_publish_marks_entity_kind_check
  CHECK (entity_kind IN ('module','template','page','pageLayout','pageModuleContent'));

--> statement-breakpoint

-- 6. Extend site_snapshots.op_kind CHECK so the new write paths can emit.
--    Existing constraint last refreshed in 0028 — append the new kinds.
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
  'unknown'
));
