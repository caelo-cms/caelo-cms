-- SPDX-License-Identifier: MPL-2.0
--
-- 0434 — reads on the Live Edit first paint that grew with history get an
-- index each, so they cost what they return (issue #1268, rule 7 of
-- docs/dev/state-and-changes.md):
--
--   * the open chats in activity order — the cross-chat banner
--     (chat.list_open_with_pending) and the Open changes overview
--     (chat.list_open_changes) walk this index and stop after one page;
--     before, they sorted every chat the shared draft ever had;
--   * a person's open page chats — chat.list_active_pages (the per-page
--     chat gate and Live Edit's resume) reads the newest open chat per page
--     of one person;
--   * the latest runs of one build kind — deploy.list_runs filtered to site
--     builds (the editor's Stage / Publish live state); the plugin-data
--     build adds a run every five minutes, so without it the newest page of
--     site builds sorted every run ever made;
--   * the live agent runs — the running-agents list filters chat_agent_runs
--     by expires_at, and expired rows stay until they are cleaned up.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE INDEX chat_sessions_open_activity_idx
  ON chat_sessions (last_active_at DESC, id DESC)
  WHERE published_at IS NULL AND archived_at IS NULL AND discarded_at IS NULL
    AND subagent_role IS NULL;

CREATE INDEX chat_sessions_open_page_owner_idx
  ON chat_sessions (created_by, page_id, created_at DESC)
  WHERE page_id IS NOT NULL AND subagent_role IS NULL
    AND published_at IS NULL AND archived_at IS NULL AND discarded_at IS NULL;

CREATE INDEX deploy_runs_kind_started_idx ON deploy_runs (build_kind, started_at DESC);

CREATE INDEX chat_agent_runs_expires_idx ON chat_agent_runs (expires_at)
  WHERE expires_at IS NOT NULL;

COMMIT;
