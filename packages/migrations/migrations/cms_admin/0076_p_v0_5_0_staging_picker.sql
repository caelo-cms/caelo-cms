-- SPDX-License-Identifier: MPL-2.0

-- v0.5.0 — staging picker + per-entity locks + list-op snapshots.
--
-- The v0.4.0 model gave us per-chat content branching but kept globals
-- (modules / theme) immediate. v0.5.0 introduces a real three-state
-- flow for globals + lists:
--
--   pending  → chat-private (chat's branch only)
--   staged   → shared overlay (every chat's preview + staging URL)
--   published → live in main
--
-- Locking model: when a chat writes to a global entity, that entity
-- is locked to the chat until publish or discard. Other chats get a
-- clear "in use by chat X" error at write time rather than silent
-- last-write-wins.

-- 1. Per-entity locks.
CREATE TABLE chat_entity_locks (
  entity_kind       text NOT NULL CHECK (entity_kind IN (
    'module',
    'template',
    'pageLayout',
    'layout',
    'structuredSet',
    'redirect'
  )),
  entity_id         uuid NOT NULL,
  chat_session_id   uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  chat_branch_id    uuid NOT NULL,
  locked_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_kind, entity_id)
);

CREATE INDEX chat_entity_locks_chat_idx
  ON chat_entity_locks (chat_session_id);

ALTER TABLE chat_entity_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_entity_locks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS chat_entity_locks_authenticated_scope ON chat_entity_locks;
CREATE POLICY chat_entity_locks_authenticated_scope ON chat_entity_locks
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

--> statement-breakpoint

-- 2. Stage state on publish marks.
-- Pre-v0.5.0 a row in chat_branch_publish_marks implicitly meant
-- "published". v0.5.0 introduces an intermediate 'staged' state +
-- a 'pending' initial state. 'pending' rows only appear when a chat
-- has emitted a snapshot but not yet staged (effectively all rows
-- start as pending and graduate via chat.stage).
ALTER TABLE chat_branch_publish_marks
  ADD COLUMN stage_state text NOT NULL DEFAULT 'published'
    CHECK (stage_state IN ('pending', 'staged', 'published'));
CREATE INDEX chat_branch_publish_marks_stage_state_idx
  ON chat_branch_publish_marks (stage_state)
  WHERE stage_state IN ('pending', 'staged');

-- Extend entity_kind enum to cover the v0.4.0 + v0.5.0 additions.
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
    'theme'
  ));

--> statement-breakpoint

-- 3. List-operation snapshots. Ordered-list structured_sets
-- (nav-menu, taxonomy, link-list) emit one row per discrete edit
-- so the stage picker can include/exclude individual items.
CREATE TABLE structured_set_operations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_snapshot_id  uuid NOT NULL REFERENCES site_snapshots(id) ON DELETE CASCADE,
  structured_set_id uuid NOT NULL REFERENCES structured_sets(id) ON DELETE CASCADE,
  op_kind           text NOT NULL CHECK (op_kind IN ('add', 'rename', 'move', 'delete', 'update')),
  item_id           text NOT NULL,
  -- op_payload shape varies per op_kind:
  --   add:    { item: <full item>, position: int }
  --   rename: { from: string, to: string }
  --   move:   { from: int, to: int }
  --   delete: { previousItem: <full item>, previousPosition: int }
  --   update: { patch: <partial item>, previousItem: <full item> }
  op_payload        jsonb NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX structured_set_operations_set_idx
  ON structured_set_operations (structured_set_id, site_snapshot_id);
CREATE INDEX structured_set_operations_site_idx
  ON structured_set_operations (site_snapshot_id);

ALTER TABLE structured_set_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE structured_set_operations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS structured_set_operations_authenticated_scope ON structured_set_operations;
CREATE POLICY structured_set_operations_authenticated_scope ON structured_set_operations
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

--> statement-breakpoint

-- 4. Site-snapshot op_kind catalog refresh (new write paths emit).
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
  -- v0.5.0 additions
  'chat.stage',
  'chat.unstage',
  'unknown'
));
