-- SPDX-License-Identifier: MPL-2.0
--
-- v0.2.54 — extended-thinking support.
--
-- Operator can toggle extended thinking per chat session. When enabled,
-- the chat-runner passes Anthropic's `thinking: { type: "enabled",
-- budget_tokens }` body parameter; the model emits a sequence of
-- `thinking` content blocks before its text/tool_use response. Each
-- thinking block carries a cryptographic signature that MUST be
-- replayed verbatim in the conversation history when the assistant
-- turn is followed by tool_results — Anthropic uses the signatures to
-- verify reasoning continuity and rejects stripped thinking with HTTP
-- 400.
--
-- Two surfaces:
--
-- 1. chat_sessions gets two new columns:
--    - extended_thinking_enabled: per-chat toggle (default off, set
--      via the chat composer's thinking switch).
--    - extended_thinking_budget_tokens: optional per-chat override
--      for the thinking budget. NULL = use the chat-runner default
--      (10000 tokens, well below max_tokens=32768 to leave headroom
--      for the response itself; Anthropic requires
--      thinking.budget_tokens < max_tokens).
--
-- 2. chat_messages gets thinking_blocks jsonb to persist the array of
--    {thinking, signature} entries the model emitted on each assistant
--    turn. NULL when extended thinking was off (or for user/tool
--    rows). chat-runner reads this back when building the messages
--    array for follow-up loops so the signatures round-trip.
--
-- All three columns are nullable / defaulted, so the migration is a
-- no-op for existing rows. RLS policies inherit; no policy changes
-- needed — these are scalar attributes on tables that already enforce
-- per-actor scope.

ALTER TABLE chat_sessions
  ADD COLUMN extended_thinking_enabled        boolean NOT NULL DEFAULT false,
  ADD COLUMN extended_thinking_budget_tokens  integer NULL;

ALTER TABLE chat_messages
  ADD COLUMN thinking_blocks jsonb NULL;

-- Conservative range: 1024 (Anthropic minimum) to 64000 (covers every
-- model's max output minus modest response headroom). Out-of-range
-- writes from the API layer are caught by the op's Zod schema; this
-- check is defense-in-depth at the storage layer.
ALTER TABLE chat_sessions
  ADD CONSTRAINT chat_sessions_extended_thinking_budget_check
    CHECK (
      extended_thinking_budget_tokens IS NULL
      OR (extended_thinking_budget_tokens BETWEEN 1024 AND 64000)
    );
