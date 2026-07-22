-- SPDX-License-Identifier: MPL-2.0
--
-- 0177 — ai_bug_reports.source: AI-filed vs auto-captured reports.
--
-- The model files defects it recognises via the bug_report tool ('ai'). New:
-- the chat-runner auto-captures EVERY failed tool result into the same channel
-- ('auto'), deduped per session — so a genuine defect can't slip past just
-- because the model didn't think to file it. Existing rows are AI-filed.

BEGIN;

ALTER TABLE ai_bug_reports ADD COLUMN source text NOT NULL DEFAULT 'ai';

COMMIT;
