-- SPDX-License-Identifier: MPL-2.0
--
-- 0401 — chat messages get a total order (#1216 follow-up).
--
-- `created_at` defaults to now(), the transaction's start time, so every
-- message a turn writes in one transaction shares one timestamp. The full
-- history read ordered by `created_at` alone (ties in whatever order the
-- heap returned), and #1216's paged read broke ties by `id`, a random
-- uuid: messages saved together came back shuffled in the editor (seen as
-- crawl status notes rendered in the wrong order, e2e chat-status-notes).
--
-- `seq` is assigned at insert, so it is the order the rows were written.
-- Reads order by (created_at, seq): across transactions by time as before,
-- within one by insertion. Existing rows are numbered in table order when
-- the column is added, which is their insertion order for append-only
-- rows like these.
--
-- Expand-safe: the previous release's INSERTs name no `seq` and get one
-- from the identity; its reads ignore the column.
-- Inherits chat_messages' RLS policies.

BEGIN;

ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS seq bigint GENERATED ALWAYS AS IDENTITY;

CREATE INDEX IF NOT EXISTS chat_messages_session_order_idx
  ON chat_messages (chat_session_id, created_at, seq);

COMMIT;
