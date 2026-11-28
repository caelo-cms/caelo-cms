-- SPDX-License-Identifier: MPL-2.0
--
-- 0900 — issue #1704: a Power-MCP replay is only ever the same call.
--
-- `chat_tool_results` caches a tool call's result under its idempotency key
-- (chat session, tool call id), and `mcp.begin_tool_call` served whatever
-- row it found under that key. The key of an MCP call is derived from the
-- JSON-RPC id of its `tools/call`, which a client may send again for a
-- different call: one that reconnects with its `Mcp-Session-Id` and counts
-- its ids from 0 again (the MCP SDK's `Client.connect` skips `initialize`
-- for a transport that already holds a session id). Every call of the new
-- connection was answered with the result of the earlier, different call
-- under the same id, marked `cached`.
--
--   call_digest   sha256 of the call's tool name and canonical arguments
--                 (admin-core `mcpCallDigest`), written when the key is
--                 reserved. A row is served only to a call with the same
--                 digest; a key that names another call is refused (or, once
--                 its window has passed, taken over by the new call). NULL
--                 for rows of the previous release and of the browser chat
--                 (`chat.cache_tool_result`): never served to an MCP call.
--
-- Expand-only: the previous release neither writes nor reads the column.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE chat_tool_results ADD COLUMN IF NOT EXISTS call_digest text NULL;

COMMIT;
