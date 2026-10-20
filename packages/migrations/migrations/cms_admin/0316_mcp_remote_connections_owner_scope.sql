-- SPDX-License-Identifier: MPL-2.0
--
-- 0316 — issue #806 review: remote MCP connections follow the mcp_tokens
-- visibility rule of migration 0315.
--
-- 0310 gave mcp_remote_connections the pre-0315 mcp_tokens policy: every
-- authenticated session read every row and any human could update any row.
-- /settings/mcp loads the list for everyone with settings.read, so an editor
-- saw which colleagues connect from outside (and, through the list op's
-- users join, their emails), and the revoke / restore / cap ops relied on
-- the route's permission check alone. The rule now, at the Postgres layer
-- (CLAUDE.md §2) so every read and write inherits it:
--
--   - read: an Owner (settings.write, via caelo_mcp_tokens_manage_all) and
--     system see every connection; everyone else only their own;
--   - insert: system only — rows are created by request-time resolution
--     (mcp_principal.ts), never by a person or the AI;
--   - update: system, or a human Owner. Revoke, restore and the cost cap are
--     the Owner's decisions; a non-Owner sees their own row read-only.
--     The AI never writes here (the ops are human/system only, and the
--     WITH CHECK refuses an `ai` session even in an Owner's chat).
--   - delete: nobody directly; rows go with their actor (ON DELETE CASCADE).
--
-- Expand-safe: the previous release does not know the table.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

DROP POLICY IF EXISTS mcp_remote_connections_authenticated_scope ON mcp_remote_connections;

CREATE POLICY mcp_remote_connections_read ON mcp_remote_connections FOR SELECT
  USING (caelo_mcp_tokens_manage_all() OR actor_id = caelo_mcp_token_principal());

CREATE POLICY mcp_remote_connections_insert ON mcp_remote_connections FOR INSERT
  WITH CHECK (current_setting('caelo.actor_kind', true) = 'system');

CREATE POLICY mcp_remote_connections_update ON mcp_remote_connections FOR UPDATE
  USING (current_setting('caelo.actor_kind', true) IN ('human', 'system')
    AND caelo_mcp_tokens_manage_all())
  WITH CHECK (current_setting('caelo.actor_kind', true) IN ('human', 'system')
    AND caelo_mcp_tokens_manage_all());

COMMIT;
