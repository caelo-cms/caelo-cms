-- SPDX-License-Identifier: MPL-2.0
--
-- 0317 — issue #902: every AI bug report records where it went.
--
-- The `bug_report` tool used to answer as if the Caelo team now knew about
-- the defect, while the row only ever lived in this install's database.
-- `forwarding_state` makes the destination explicit so the tool result,
-- the AI's message to the operator and /settings/bugs all say the same
-- thing:
--
--   local_only — stored here; nobody outside this install sees it
--   queued     — the Owner opted in; waiting to be sent to the Caelo team
--   sent       — the Caelo bug intake accepted it
--   failed     — the intake refused it for good (reason in a later column)
--
-- Only `local_only` is written until forwarding ships (#904); the full set
-- is declared now so that release needs no constraint swap.
--
-- Expand-safe: the previous release does not read the column, and the
-- default keeps its INSERTs valid.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE ai_bug_reports
  ADD COLUMN IF NOT EXISTS forwarding_state text NOT NULL DEFAULT 'local_only'
    CHECK (forwarding_state IN ('local_only', 'queued', 'sent', 'failed'));

COMMIT;
