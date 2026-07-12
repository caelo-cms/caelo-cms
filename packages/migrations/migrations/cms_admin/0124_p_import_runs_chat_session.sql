-- SPDX-License-Identifier: MPL-2.0
--
-- 0124 — import_runs learns its chat origin (issue: the chat's
-- "Pending your approval" strip is fed by pending_proposals.list,
-- which filters per chat session; import_runs had no chat linkage,
-- so approved-in-chat crawls were invisible to the strip and only
-- the transcript card (mid-scroll) carried the Approve button —
-- operator: "missed it nearly").

BEGIN;

ALTER TABLE import_runs
  ADD COLUMN IF NOT EXISTS chat_session_id uuid REFERENCES chat_sessions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS import_runs_chat_session_idx
  ON import_runs (chat_session_id) WHERE chat_session_id IS NOT NULL;

COMMIT;
