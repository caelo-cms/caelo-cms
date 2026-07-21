-- SPDX-License-Identifier: MPL-2.0
--
-- 0171 — turn extended thinking ON by default for NEW main chat sessions.
--
-- The thinking A/B (non-thinking vs thinking, full e2e-livedit suite minus
-- migrate) showed thinking is faster on 7 of 9 scenarios and at least as
-- correct. The two regressions were both explained away, not intrinsic:
--   * genesis got slower purely because the SUBAGENT drafts reasoned deeper
--     — fixed by forcing thinking OFF for subagent turns (chat-runner
--     index.ts: thinkingEnabled && subagentResultCapture === undefined).
--   * onboarding failed on a mixed-turn tool-pairing bug (a gated + a
--     non-gated tool co-emitted in one turn) that thinking merely exposed —
--     fixed in loop.ts (dispatch non-gated co-emitted calls before pausing).
--
-- So: main chats think by default; subagents never do (enforced in code,
-- independent of this column). Existing sessions keep their stored value;
-- only new sessions inherit this default. Operators can still toggle it
-- per chat in the composer.

BEGIN;

ALTER TABLE chat_sessions ALTER COLUMN extended_thinking_enabled SET DEFAULT true;

COMMIT;
