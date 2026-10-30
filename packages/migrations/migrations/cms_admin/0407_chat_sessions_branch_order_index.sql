-- SPDX-License-Identifier: MPL-2.0
--
-- 0407 — issue #1254: the entity-lock holder lookup stays O(1) however
-- many chats the shared draft has seen.
--
-- Every entity write on a chat branch resolves the writing chat
-- (`checkAndAcquireEntityLock`, admin-core locks.ts). On the shared draft
-- every chat ever opened shares ONE branch, and the lookup sorted all of
-- them by an expression no index serves (searchVIU: 116 chats, growing
-- with every agent session). The lookup now reads the caller's own chat by
-- primary key and otherwise the branch's first chat; this index serves the
-- second read with a one-row range scan and replaces the plain branch
-- index (a prefix of it, so nothing else loses its index).

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE INDEX IF NOT EXISTS chat_sessions_branch_created_idx
  ON chat_sessions (chat_branch_id, created_at);
DROP INDEX IF EXISTS chat_sessions_chat_branch_idx;

COMMIT;
