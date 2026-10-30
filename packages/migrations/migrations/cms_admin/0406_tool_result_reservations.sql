-- SPDX-License-Identifier: MPL-2.0
--
-- 0406 — issue #1253 (PR #1273 review): a repeated Power-MCP tool call
-- never runs twice.
--
-- `chat_tool_results` caches a tool call's result under its idempotency key
-- (chat session, tool call id), written once the tool finished. With the
-- per-chat turn lease gone, a client retrying a call while the first one
-- still runs found no cached row and ran the tool a second time (a create
-- without a natural key then created twice). A call now RESERVES its key
-- before the tool runs: a `pending` row, turned into the result when the
-- call finishes. A repeat that finds the reservation is told the call is
-- still running instead of starting it again; a reservation whose call
-- died with its process is taken over after a timeout (admin-core
-- mcp_tool_call.ts).
--
-- Expand-only: the previous release writes finished rows only (the
-- default) and its lookups do not know the column.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE chat_tool_results ADD COLUMN IF NOT EXISTS pending boolean NOT NULL DEFAULT false;

COMMIT;
