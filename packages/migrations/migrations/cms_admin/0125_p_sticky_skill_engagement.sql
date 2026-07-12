-- SPDX-License-Identifier: MPL-2.0
--
-- 0125 — sticky per-chat skill engagement. The auto-matcher scores
-- ONLY the current user message; mid-flow answers like "B — Light
-- refresh" carry no keywords, so the skill that owned the flow
-- silently dropped out between turns (live-hit 2026-07-12: the
-- site-migrate skill vanished for the scope turn and the AI queued a
-- full crawl without asking). The runner now persists which skills
-- auto-engaged in this chat and re-engages them on later turns;
-- manual disengagement still wins (CLAUDE.md two-level invariant).

BEGIN;

ALTER TABLE chat_sessions
  ADD COLUMN IF NOT EXISTS auto_engaged_skills jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMIT;
