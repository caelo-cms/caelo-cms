-- SPDX-License-Identifier: MPL-2.0
--
-- 0454 — issue #1253: a write conflicts with the version its caller read,
-- not with who wrote last.
--
-- The draft's optimistic versioning (#620, 0246) only compares OWNERS: a
-- write is refused when ANOTHER chat changed the entity after this chat
-- last saw it. Two tool calls of one agent running at the same time
-- (parallel calls, sub-agents sharing a session) are one owner, so the
-- second overwrote the first silently.
--
-- Every entity write takes its `chat_entity_locks` row FOR UPDATE, so the
-- row is where concurrent writers of one entity meet. It now records the
-- transaction that last wrote the entity and the tool call it belonged to.
-- A Power-MCP call takes the database snapshot it started with; a write of
-- that call is a conflict when the entity's last write is by another call
-- and was not yet visible in that snapshot (`pg_visible_in_snapshot`) —
-- exactly "someone wrote this after you started", whoever it was.
--
-- Expand-only: two nullable columns. The previous release ignores them.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE chat_entity_locks
  ADD COLUMN IF NOT EXISTS last_write_xid xid8 NULL,
  ADD COLUMN IF NOT EXISTS last_write_call text NULL
    CHECK (last_write_call IS NULL OR char_length(last_write_call) BETWEEN 1 AND 200);

COMMIT;
