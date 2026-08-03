-- SPDX-License-Identifier: MPL-2.0
--
-- Issue #376 — Power-MCP token scope. A 'chat' token drives the existing
-- caelo_chat surface only (mcp.send_chat). An 'admin' token additionally
-- unlocks the Power-MCP surface (mcp.list_tools / mcp.execute_tool /
-- mcp.open_session / mcp.get_context) that exposes the chat-runner tool
-- catalogue to an external agent. Existing rows stay 'chat' — the
-- narrower surface — so no pre-existing bearer silently gains power.

ALTER TABLE mcp_tokens
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'chat'
    CHECK (scope IN ('chat', 'admin'));
