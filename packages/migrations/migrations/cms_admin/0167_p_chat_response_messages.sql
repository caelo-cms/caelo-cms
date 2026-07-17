-- SPDX-License-Identifier: MPL-2.0
--
-- 0167 — chat_messages.response_messages (option C: SDK-canonical history).
--
-- We reach every model through the Vercel AI SDK (CLAUDE.md §12). The SDK
-- assembles each assistant turn's messages — provider-executed tool blocks
-- (server_tool_use ↔ tool_search_tool_result), reasoning + signatures, and
-- tool-call pairing — correctly, and exposes them as `response.messages`.
-- Rebuilding that history ourselves from the `fullStream` event union is
-- what dropped the paired tool-search result and 400'd run-B6.
--
-- This column stores that canonical assembly per assistant turn. Replay
-- reads it verbatim and hands it straight back to the SDK — no
-- reconstruction. Pre-1.0, no production data: this is a hard cut to the
-- new format (no dual-reader). `content` stays for the UI/display + the
-- empty-turn guard; the legacy `tool_calls` / `thinking_blocks` columns
-- are no longer read for replay (kept nullable for display/audit).

ALTER TABLE chat_messages
  ADD COLUMN response_messages jsonb NULL;
