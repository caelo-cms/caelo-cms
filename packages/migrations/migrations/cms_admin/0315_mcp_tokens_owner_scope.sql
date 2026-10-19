-- SPDX-License-Identifier: MPL-2.0
--
-- 0315 — MCP tokens are visible per user (maintainer decision 2026-10-19,
-- follow-up of PR #889).
--
-- Until now the mcp_tokens policy let every authenticated actor read every
-- row, so an editor or reviewer opening /settings/mcp saw all users' token
-- names, scopes and last use, and the revoke op would revoke any id it was
-- handed. The rule now:
--
--   - an Owner — whoever holds `settings.write`, the permission that
--     already gates minting, revoking and approving MCP tokens (#589) —
--     sees and revokes every user's token;
--   - everyone else sees and revokes only the tokens they own
--     (`actor_id`);
--   - the AI acting in a chat follows the person who owns that chat (the
--     principal rule of caelo_branch_visible, migration 0249): in an
--     Owner's chat it may propose revoking any token, in an editor's chat
--     only the editor's own. An AI context without a chat task falls back
--     to its own actor id, which owns no tokens and holds no permission,
--     so it sees nothing;
--   - system sees everything (token resolution in resolveMcpToken, the
--     users.delete revocation run by the elevated route, workers);
--   - plugin actors see nothing.
--
-- The scope lives here rather than in the ops so every read inherits it —
-- the list op, revoke, the AI's propose_revoke preview, and any read added
-- later (CLAUDE.md §2: per-actor scoping lives at the Postgres layer). The
-- ops only turn "no visible row" into an actionable error. Another user's
-- token and a nonexistent id look the same to a non-Owner.
--
-- Expand-safe: the previous release reads tokens through the same ops and
-- keeps working; it simply sees the narrower set.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

-- The person whose tokens the current actor acts for: the human themselves,
-- or for the AI the owner of the chat its task belongs to.
CREATE FUNCTION caelo_mcp_token_principal() RETURNS uuid
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
                  THEN r.task::uuid END AS task
      FROM raw r
    )
    SELECT CASE
             WHEN w.kind = 'human' THEN w.actor
             WHEN w.kind = 'ai' AND w.task IS NOT NULL THEN
               (SELECT cs.created_by FROM chat_sessions cs WHERE cs.id = caelo_chat_owner(w.task))
             WHEN w.kind = 'ai' THEN w.actor
           END
    FROM who w
  $$;

-- Whether the current actor manages every user's MCP tokens: system, or a
-- principal holding settings.write.
CREATE FUNCTION caelo_mcp_tokens_manage_all() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$
    SELECT current_setting('caelo.actor_kind', true) = 'system'
      OR (current_setting('caelo.actor_kind', true) IN ('human', 'ai') AND EXISTS (
        SELECT 1 FROM user_roles ur
        JOIN role_permissions rp ON rp.role_id = ur.role_id
        JOIN permissions p ON p.id = rp.permission_id
        WHERE ur.user_id = caelo_mcp_token_principal() AND p.name = 'settings.write'
      ))
  $$;

COMMENT ON FUNCTION caelo_mcp_tokens_manage_all() IS
  'May the current actor (caelo.* session vars) see and revoke every user''s MCP tokens? See migration 0315.';

DROP POLICY IF EXISTS mcp_tokens_authenticated_scope ON mcp_tokens;

CREATE POLICY mcp_tokens_read ON mcp_tokens FOR SELECT
  USING (caelo_mcp_tokens_manage_all() OR actor_id = caelo_mcp_token_principal());

-- Writes stay human/system only, as before: the AI reaches token
-- lifecycle through the approval-gated propose ops.
CREATE POLICY mcp_tokens_insert ON mcp_tokens FOR INSERT
  WITH CHECK (current_setting('caelo.actor_kind', true) IN ('human', 'system')
    AND (caelo_mcp_tokens_manage_all() OR actor_id = caelo_mcp_token_principal()));

CREATE POLICY mcp_tokens_update ON mcp_tokens FOR UPDATE
  USING (caelo_mcp_tokens_manage_all() OR actor_id = caelo_mcp_token_principal())
  WITH CHECK (current_setting('caelo.actor_kind', true) IN ('human', 'system')
    AND (caelo_mcp_tokens_manage_all() OR actor_id = caelo_mcp_token_principal()));

CREATE POLICY mcp_tokens_delete ON mcp_tokens FOR DELETE
  USING (current_setting('caelo.actor_kind', true) IN ('human', 'system')
    AND (caelo_mcp_tokens_manage_all() OR actor_id = caelo_mcp_token_principal()));

COMMIT;
