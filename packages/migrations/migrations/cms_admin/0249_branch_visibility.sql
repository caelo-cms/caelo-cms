-- SPDX-License-Identifier: MPL-2.0
--
-- 0249 — issue #569: a chat branch is visible only to the people allowed
-- to see it.
--
-- Every branch overlay is read through an op whose ExecutionContext (or
-- input) names the branch. Before this migration nothing checked that the
-- caller may see that branch: `/edit/preview/<page>?branch=<id>` rendered
-- any chat's unpublished work for whatever id the URL carried. The Query
-- API adapter now asks `caelo_branch_visible(branch)` before it runs an
-- op on a named branch and answers "branch not found" when it is false,
-- so every surface that takes a branch id inherits the check.
--
-- Who may see a branch:
--   - the shared site draft (`site_draft.branch_id`, #620): every
--     authenticated actor — all chats work in it together;
--   - any other branch (an experiment, a migration, a legacy chat
--     branch): the person who owns a chat bound to it, or anyone holding
--     the new `drafts.view_all` permission (granted to the built-in
--     owner role; custom roles may be given it);
--   - the AI acting in a chat: whatever the person who owns that chat may
--     see (the principal is the owner of the chat its task belongs to — a
--     subagent's task maps to its parent chat), so the chat's own branch
--     is visible to it and another editor's isolated branch is not;
--   - system and plugin actors: always. They never take a branch from a
--     request; the host or the server hands them one it already resolved
--     (the static generator, the signed screenshot render, plugin calls
--     made from an authorized chat). An AI context without a chat task is
--     server-built the same way (mcp.send_chat binds it to a session it
--     verified first).
--
-- A branch that does not exist is not visible to anyone but the trusted
-- actors above, so "not yours" and "does not exist" are indistinguishable.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

INSERT INTO permissions (name, description) VALUES
  ('drafts.view_all', 'View every chat''s unpublished branch, including other editors'' experiments and migrations')
ON CONFLICT (name) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'owner' AND p.name = 'drafts.view_all'
ON CONFLICT DO NOTHING;

CREATE FUNCTION caelo_branch_visible(branch uuid) RETURNS boolean
  LANGUAGE sql STABLE
  AS $$
    WITH raw AS (
      SELECT NULLIF(current_setting('caelo.actor_kind', true), '') AS kind,
             current_setting('caelo.actor_id', true) AS actor,
             current_setting('caelo.chat_task_id', true) AS task
    ),
    -- Only a well-formed uuid is cast: a malformed id names nobody.
    who AS (
      SELECT r.kind,
             CASE WHEN r.actor ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  THEN r.actor::uuid END AS actor,
             CASE WHEN r.task ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  THEN r.task::uuid END AS task,
             NULLIF(r.task, '') IS NULL AS no_task
      FROM raw r
    ),
    principal AS (
      SELECT w.kind, w.no_task,
             CASE
               WHEN w.kind = 'human' THEN w.actor
               WHEN w.kind = 'ai' THEN
                 (SELECT cs.created_by FROM chat_sessions cs WHERE cs.id = caelo_chat_owner(w.task))
             END AS person
      FROM who w
    )
    SELECT COALESCE(p.kind IS NOT NULL AND (
      p.kind IN ('system', 'plugin')
      OR (p.kind = 'ai' AND p.no_task)
      OR branch = (SELECT d.branch_id FROM site_draft d WHERE d.id = 1)
      OR EXISTS (
        SELECT 1 FROM chat_sessions cs
        WHERE cs.chat_branch_id = branch
          AND cs.created_by = p.person
      )
      OR EXISTS (
        SELECT 1 FROM user_roles ur
        JOIN role_permissions rp ON rp.role_id = ur.role_id
        JOIN permissions pm ON pm.id = rp.permission_id
        WHERE ur.user_id = p.person AND pm.name = 'drafts.view_all'
      )
    ), false)
    FROM principal p
  $$;

COMMENT ON FUNCTION caelo_branch_visible(uuid) IS
  'Issue #569: may the current actor (caelo.* session vars) see this chat branch? See migration 0249 for the rule.';

COMMIT;
