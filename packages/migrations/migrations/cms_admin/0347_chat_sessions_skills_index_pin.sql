-- SPDX-License-Identifier: MPL-2.0
--
-- 0347 — a chat's `# Skills` index stays fixed while a plugin fails and
-- recovers (#1008).
--
-- A plugin's skills are offered only on a server process that runs the
-- plugin. The index sits in the cached system prefix and is never rewritten
-- mid-chat (CLAUDE.md §2), so which plugin skills it left out must be fixed
-- when the chat's index is first built, not re-derived from the current
-- state on every turn:
--
--   chat_sessions.skills_index_unavailable — the slugs of the plugin skills
--   the index left out because their plugin did not run on the server that
--   built it. NULL until the index is built (and for chats from before this
--   column, until their next turn). Written once; later availability
--   changes reach the chat as history notices.
--
-- Expand-only: a nullable column. Inherits chat_sessions' RLS policies.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE chat_sessions
  ADD COLUMN IF NOT EXISTS skills_index_unavailable jsonb
    CHECK (skills_index_unavailable IS NULL OR jsonb_typeof(skills_index_unavailable) = 'array');

COMMIT;
