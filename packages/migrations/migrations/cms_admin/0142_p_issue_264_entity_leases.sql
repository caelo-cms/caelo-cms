-- SPDX-License-Identifier: MPL-2.0
--
-- 0142 — per-entity sub-leases within a shared chat branch (issue #264,
-- the "task leases" slice; closes the concurrent-writer gap PR #291
-- surfaced).
--
-- THE GAP. chat_entity_locks (0076) keys on the chat-branch SESSION id.
-- Parallel sibling subagents (issue #264 fan-out) all run on the PARENT
-- chat's branch (chatBranchIdOverride), so every sibling resolves to the
-- SAME session and the branch lock permits ALL of them to write the SAME
-- module / page. Two siblings touching one entity is then a silent
-- last-writer-wins lost update, not a clean failure.
--
-- THE FIX. A short-TTL sub-lease keyed on (entity, branch) whose HOLDER
-- is the acquiring writer's OWN chat session (ctx.chatTaskId — the parent
-- orchestrator's session for the orchestrator, each subagent's ephemeral
-- session for a subagent). A sibling on the same branch trying to write
-- the same entity finds the lease held by a DIFFERENT holder and is
-- refused cleanly. The same holder re-acquiring is a no-op refresh, so
-- the parent-session and sequential single-writer paths are unaffected.
--
-- TTL + auto-release. Leases carry expires_at so a died / timed-out
-- subagent never wedges an entity forever: acquisition treats an expired
-- lease as free and takes it over. Leases are also released explicitly on
-- subagent_runs.finish (by holder) and on chat publish / discard (by
-- branch). This is the scoped "stale locks wedge runs" fix (#262 / #268).

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE entity_leases (
  entity_kind text NOT NULL CHECK (entity_kind IN (
    'module',
    'template',
    'pageLayout',
    'layout',
    'structuredSet',
    'redirect',
    'page',
    'siteSettings',
    'siteDefaults',
    'contentInstance',
    'theme'
  )),
  entity_id   uuid        NOT NULL,
  -- Plain uuid, not an FK: mirrors chat_entity_locks.chat_branch_id.
  -- There is no dedicated branches table; branch ids live on
  -- chat_sessions.chat_branch_id. Cleanup is TTL + explicit release.
  branch_id   uuid        NOT NULL,
  -- The acquiring writer's OWN session (ctx.chatTaskId). Distinguishes
  -- sibling subagents that share branch_id.
  holder_key  text        NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  -- One live lease per (entity, branch). The PK btree also serves the
  -- (entity, branch) acquisition lookup.
  PRIMARY KEY (entity_kind, entity_id, branch_id)
);

-- Release-by-holder (subagent_runs.finish) and release-by-branch
-- (chat publish / discard) both need a non-PK lookup path.
CREATE INDEX entity_leases_holder_idx ON entity_leases (holder_key);
CREATE INDEX entity_leases_branch_idx ON entity_leases (branch_id);

ALTER TABLE entity_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_leases FORCE  ROW LEVEL SECURITY;

-- Per-actor scoping (PR #295 review). A bare "any authenticated actor"
-- policy would let any AI session delete or rewrite any lease — a
-- lease-steal primitive. Scope per actor kind:
--   * system — migrations, seeds, GC, test truncation: unrestricted.
--   * human  — unrestricted: the ops that clear leases wholesale
--     (chat.publish / chat.merge_to_main / chat.archive_session via
--     releaseChatLocks) are human+system at the Query API layer, and a
--     lease row has no owning human actor to scope by.
--   * ai     — only rows on the branch the AI is currently writing
--     (caelo.chat_branch_id) or held by its own session
--     (caelo.chat_task_id). This covers every runtime AI path:
--     acquire / refresh / expired-takeover in acquireEntityLease run
--     with the row's branch_id in caelo.chat_branch_id (including
--     SEEING a live sibling's row so the refusal stays clean), and
--     subagent_runs.finish's release-by-holder runs from the parent
--     orchestrator's turn whose branch is where the child's leases live.
--   * plugin / unset GUCs — no disjunct matches; fail closed.
DROP POLICY IF EXISTS entity_leases_per_actor_scope ON entity_leases;
CREATE POLICY entity_leases_per_actor_scope ON entity_leases
  USING (
    current_setting('caelo.actor_kind', true) IN ('human', 'system')
    OR (
      current_setting('caelo.actor_kind', true) = 'ai'
      AND (
        branch_id = NULLIF(current_setting('caelo.chat_branch_id', true), '')::uuid
        OR holder_key = NULLIF(current_setting('caelo.chat_task_id', true), '')
      )
    )
  )
  WITH CHECK (
    current_setting('caelo.actor_kind', true) IN ('human', 'system')
    OR (
      current_setting('caelo.actor_kind', true) = 'ai'
      AND (
        branch_id = NULLIF(current_setting('caelo.chat_branch_id', true), '')::uuid
        OR holder_key = NULLIF(current_setting('caelo.chat_task_id', true), '')
      )
    )
  );

COMMIT;
