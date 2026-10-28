-- SPDX-License-Identifier: MPL-2.0
--
-- 0396 — chat messages keep the order they were written in (#1216 follow-up).
--
-- `chat_messages.created_at` defaulted to now(), the transaction's start
-- time, so every message one transaction writes carries the same
-- timestamp. The transcript is read a page at a time (#1222) ordered by
-- (created_at, id), and `id` is a random uuid: messages written together
-- came back in random order (CI: status notes seeded in one transaction
-- rendered "Crawl finished" before the crawl tick). clock_timestamp()
-- advances within a transaction, so (created_at, id) follows insertion
-- order — the same fix 0346 made for deploy_runs.started_at.
--
-- Expand-safe: only the column default changes; existing rows and the
-- previous release's INSERTs (which name no created_at) are unaffected.
-- Inherits chat_messages' RLS policies.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE chat_messages
  ALTER COLUMN created_at SET DEFAULT clock_timestamp();

COMMIT;
