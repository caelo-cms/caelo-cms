-- SPDX-License-Identifier: MPL-2.0
--
-- 0246 — issue #620 Parts A + B: one shared draft per site, the agent may
-- Stage, and an AI Stage never auto-publishes.
--
-- 1. `site_draft` — the singleton holding the site's shared draft branch.
--    New chats bind to it by default; experiments and site migrations get
--    an isolated branch (`chat_sessions.branch_kind`). Chats that existed
--    before this migration keep their own branches untouched ('legacy'):
--    nothing is auto-merged into the draft at rollout.
--
-- 2. `chat_sessions` — the one-session-per-branch UNIQUE goes (every draft
--    chat shares the draft branch); `branch_kind` says how the chat is
--    bound; `parent_chat_session_id` attributes a subagent's writes to the
--    chat that spawned it (subagents work on their parent's binding).
--
-- 3. `site_snapshots.staged_at` / `undone_at` — per-snapshot pending
--    state. A Stage of SELECTED draft chats consumes exactly their
--    snapshots, so a per-session "last staged at" timestamp can no longer
--    say what is pending. Pending = on a branch, not staged, not undone.
--    Backfilled from every existing chat's last_staged_at / published_at,
--    so legacy branches keep exactly the pending set they had.
--
-- 4. `caelo_chat_owner(task)` — the chat a snapshot belongs to: the
--    snapshot's chat task, or that task's parent chat for a subagent.
--
-- 5. `draft_entity_observations` — optimistic per-entity versioning inside
--    the draft (no locks between draft chats): the last time a chat saw an
--    entity's draft state. A write over a newer change by ANOTHER chat is
--    a gentle conflict ("re-read it, then redo your edit").
--
-- 6. `ai_stage_holds` — Part B's hard rule. A Stage the AI initiated
--    leaves main holding changes no human has published; while such a
--    hold is open, no automatic production publish (auto-redeploy direct
--    build or the audit-gated automatic publish) may run. A human Publish
--    live (or an Owner-initiated production build) releases exactly the
--    holds its build covers (`deploy_runs.covered_ai_hold_ids`).
--
-- 7. `layout_module_snapshots` — layout chrome placed inside a chat is
--    pending draft state (restorable, stageable), not a live write.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE site_draft (
  id         integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  branch_id  uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO site_draft (id) VALUES (1);
ALTER TABLE site_draft ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_draft FORCE ROW LEVEL SECURITY;
CREATE POLICY site_draft_authenticated_scope ON site_draft
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

ALTER TABLE chat_sessions DROP CONSTRAINT IF EXISTS chat_sessions_chat_branch_id_key;
CREATE INDEX chat_sessions_chat_branch_idx ON chat_sessions (chat_branch_id);
ALTER TABLE chat_sessions
  ADD COLUMN branch_kind text NOT NULL DEFAULT 'draft'
    CHECK (branch_kind IN ('draft', 'experiment', 'migration', 'legacy')),
  ADD COLUMN parent_chat_session_id uuid NULL REFERENCES chat_sessions(id) ON DELETE SET NULL;
UPDATE chat_sessions SET branch_kind = 'legacy';
UPDATE chat_sessions cs SET parent_chat_session_id = sr.parent_chat_session_id
  FROM subagent_runs sr
  WHERE sr.subagent_chat_session_id = cs.id AND sr.parent_chat_session_id IS NOT NULL;

ALTER TABLE site_snapshots
  ADD COLUMN staged_at timestamptz NULL,
  ADD COLUMN undone_at timestamptz NULL;
UPDATE site_snapshots ss SET staged_at = cs.last_staged_at
  FROM chat_sessions cs
  WHERE ss.chat_branch_id = cs.chat_branch_id
    AND cs.last_staged_at IS NOT NULL AND ss.created_at <= cs.last_staged_at;
UPDATE site_snapshots ss SET staged_at = cs.published_at
  FROM chat_sessions cs
  WHERE ss.chat_branch_id = cs.chat_branch_id
    AND cs.published_at IS NOT NULL AND ss.staged_at IS NULL;
CREATE INDEX site_snapshots_branch_pending_idx ON site_snapshots (chat_branch_id, created_at)
  WHERE chat_branch_id IS NOT NULL AND staged_at IS NULL AND undone_at IS NULL;

-- The undo of a draft chat records one (non-pending) history header.
ALTER TABLE site_snapshots DROP CONSTRAINT IF EXISTS site_snapshots_op_kind_check;
ALTER TABLE site_snapshots
  ADD CONSTRAINT site_snapshots_op_kind_check CHECK (op_kind IN (
    'modules.create', 'modules.update', 'modules.delete',
    'templates.create', 'templates.update', 'templates.delete', 'template_blocks.set',
    'pages.create', 'pages.update', 'pages.set_modules', 'pages.delete',
    'snapshots.revert_site', 'snapshots.revert_module', 'snapshots.revert_template',
    'snapshots.revert_page',
    'chat.publish', 'chat.merge_to_main', 'chat.stage', 'chat.unstage',
    'layout_modules.set', 'page_module_content.set', 'structured_sets.set',
    'redirects.create', 'redirects.update', 'redirects.delete',
    'content_instances.create', 'content_instances.set_values', 'content_instances.delete',
    'placement.set_content', 'placement.fork_content', 'unknown',
    'themes.update_tokens', 'themes.set_asset', 'themes.duplicate', 'themes.import_dtcg',
    'themes.import', 'themes.activate', 'themes.update_meta',
    'plugin_storage.insert', 'plugin_storage.update', 'plugin_storage.delete',
    'chat.discard_branch', 'chat.adopt_change', 'chat.undo_changes'
  ));

CREATE FUNCTION caelo_chat_owner(task uuid) RETURNS uuid
  LANGUAGE sql STABLE
  AS $$
    SELECT COALESCE(
      (SELECT parent_chat_session_id FROM chat_sessions WHERE id = task),
      task
    )
  $$;

CREATE TABLE draft_entity_observations (
  chat_session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  entity_kind     text NOT NULL,
  entity_id       uuid NOT NULL,
  seen_at         timestamptz NOT NULL,
  PRIMARY KEY (chat_session_id, entity_kind, entity_id)
);
ALTER TABLE draft_entity_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE draft_entity_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY draft_entity_observations_authenticated_scope ON draft_entity_observations
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

CREATE TABLE ai_stage_holds (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The chats whose changes the AI merged into main.
  chat_session_ids     uuid[] NOT NULL,
  actor_id             uuid NOT NULL REFERENCES actors(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  released_at          timestamptz NULL,
  -- The production deploy run of the human publish that released it.
  released_by_run_id   uuid NULL REFERENCES deploy_runs(id) ON DELETE SET NULL
);
CREATE INDEX ai_stage_holds_open_idx ON ai_stage_holds (created_at) WHERE released_at IS NULL;
ALTER TABLE ai_stage_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_stage_holds FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_stage_holds_authenticated_scope ON ai_stage_holds
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

-- The holds a build covers, read as it starts (a hold visible then was
-- committed together with its merge, so the build contains that merge). A
-- human production publish releases exactly these — never by time.
ALTER TABLE deploy_runs ADD COLUMN covered_ai_hold_ids uuid[] NULL;

-- Layout chrome placements written inside a chat are draft state like
-- every other content change: the latest pending row per (layout, block)
-- overlays the live `layout_modules` in that branch's views, a Stage
-- replays it into the live table, an undo simply stops it being pending.
-- state: { schemaVersion: 1, moduleIds: [uuid, ...] }
CREATE TABLE layout_module_snapshots (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_snapshot_id  uuid NOT NULL REFERENCES site_snapshots(id) ON DELETE CASCADE,
  layout_id         uuid NOT NULL REFERENCES layouts(id) ON DELETE CASCADE,
  block_name        text NOT NULL,
  state             jsonb NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX layout_module_snapshots_block_idx
  ON layout_module_snapshots (layout_id, block_name, site_snapshot_id);
CREATE INDEX layout_module_snapshots_site_idx ON layout_module_snapshots (site_snapshot_id);
ALTER TABLE layout_module_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE layout_module_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY layout_module_snapshots_authenticated_scope ON layout_module_snapshots
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

-- 8. Skills (CLAUDE.md §2: new AI behaviour ships as skills). Targeted
--    `replace()` guarded by `body LIKE` on the exact old sentence:
--    idempotent, a no-op on an install whose text has moved on, and it
--    never touches an Owner-edited body that no longer carries it.
--    - site-migrate: a migration starts on its own branch, and the AI
--      stages the result itself (Publish live stays the operator's).
--    - fix-quality-findings: the AI re-stages its fixes itself.
UPDATE skills
   SET body = replace(
     body,
     E'Workflow:\n\n0. NO URL YET',
     E'Workflow:\n\nBEFORE ANYTHING ELSE: call `start_isolated_branch({reason: "migration"})` so the migration builds on its own branch instead of the site''s shared draft (other chats keep working undisturbed; it reaches the site only when staged). If it says this chat already has unstaged changes, ask the operator to start the migration in a new chat.\n\n0. NO URL YET'
   )
 WHERE slug = 'site-migrate'
   AND body LIKE E'%Workflow:\n\n0. NO URL YET%'
   AND body NOT LIKE '%start_isolated_branch%';

UPDATE skills
   SET body = replace(
     body,
     '- Then tell the operator to click Stage in /edit to rebuild the staging preview, and CLOSE with',
     '- Then Stage it yourself with `stage_changes` (staging preview + quality check; Publish live stays the operator''s click), and CLOSE with'
   )
 WHERE slug = 'site-migrate'
   AND body LIKE '%- Then tell the operator to click Stage in /edit to rebuild the staging preview, and CLOSE with%';

UPDATE skills
   SET body = replace(
     body,
     'bulk-publish first, then have the operator re-stage.',
     'bulk-publish first, then stage again with `stage_changes`.'
   )
 WHERE slug = 'site-migrate'
   AND body LIKE '%bulk-publish first, then have the operator re-stage.%';

UPDATE skills
   SET body = replace(
     body,
     'when you are done, tell the operator in one sentence what you fixed and ask them to Stage again (if the fix changed nothing on the chat branch — SEO texts are written live — they use "Stage again" in the toolbar).',
     'when you are done, Stage again yourself with `stage_changes` (it rebuilds staging even when the fix changed nothing in the draft — SEO texts are written live) and tell the operator in one sentence what you fixed. Publish live stays the operator''s click.'
   )
 WHERE slug = 'fix-quality-findings'
   AND body LIKE '%when you are done, tell the operator in one sentence what you fixed and ask them to Stage again (if the fix changed nothing on the chat branch — SEO texts are written live — they use "Stage again" in the toolbar).%';

UPDATE skills
   SET allowlisted_tools = allowlisted_tools || '["stage_changes"]'::jsonb
 WHERE slug = 'fix-quality-findings'
   AND jsonb_array_length(allowlisted_tools) > 0
   AND NOT allowlisted_tools @> '["stage_changes"]'::jsonb;

COMMIT;
