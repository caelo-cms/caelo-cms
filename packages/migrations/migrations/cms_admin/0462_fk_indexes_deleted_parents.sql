-- SPDX-License-Identifier: MPL-2.0
--
-- 0462 — issue #1291: foreign keys whose parent row is really deleted get
-- an index on the referencing column.
--
-- Deleting a parent row makes Postgres look up every referencing row
-- (`$1 = col`, to cascade, set NULL or refuse). Without an index on the
-- referencing column each lookup scans the whole child table, once per
-- deleted parent row. Only parents that production deletes are covered
-- here: chat sessions (the subagent session GC,
-- `subagent_runs.gc_old_sessions`, and its cascade to chat_messages),
-- roles, themes, domains and plugins (their delete / uninstall ops).
-- Pages, modules, media, snapshots, deploy runs, AI calls and users are
-- soft-deleted or kept, so their FKs only get an index where a reader
-- needs one (0460/0461/0463); FKs to `actors` stay unindexed for the same
-- reason (actors are never deleted). The decisions are listed in #1291's
-- PR.
--
-- Partial `IS NOT NULL` indexes: every column here is nullable and mostly
-- NULL, and `$1 = col` implies `col IS NOT NULL`, so the FK check still
-- uses them. Plain CREATE INDEX in the runner's transaction: proposal,
-- pending-action and plugin tables stay small. The chat_sessions FKs on
-- the per-request tables (ai_calls.parent_chat_session_id,
-- page_edit_log.chat_session_id) are built CONCURRENTLY in 0463.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

-- chat_sessions: deleted by the subagent session GC.
CREATE INDEX IF NOT EXISTS chat_sessions_parent_chat_session_id_idx
  ON chat_sessions (parent_chat_session_id)
  WHERE parent_chat_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS site_memory_proposals_chat_session_id_idx
  ON site_memory_proposals (chat_session_id)
  WHERE chat_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS skill_proposals_chat_session_id_idx
  ON skill_proposals (chat_session_id)
  WHERE chat_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS plugin_rate_limit_proposals_chat_session_id_idx
  ON plugin_rate_limit_proposals (chat_session_id)
  WHERE chat_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS image_requests_chat_session_id_idx
  ON image_requests (chat_session_id)
  WHERE chat_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_providers_pending_actions_chat_session_id_idx
  ON ai_providers_pending_actions (chat_session_id)
  WHERE chat_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS deploy_pending_actions_chat_session_id_idx
  ON deploy_pending_actions (chat_session_id)
  WHERE chat_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS domain_pending_actions_chat_session_id_idx
  ON domain_pending_actions (chat_session_id)
  WHERE chat_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_config_pending_actions_chat_session_id_idx
  ON email_config_pending_actions (chat_session_id)
  WHERE chat_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS layout_pending_actions_chat_session_id_idx
  ON layout_pending_actions (chat_session_id)
  WHERE chat_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mcp_token_pending_actions_chat_session_id_idx
  ON mcp_token_pending_actions (chat_session_id)
  WHERE chat_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS owner_settings_pending_actions_chat_session_id_idx
  ON owner_settings_pending_actions (chat_session_id)
  WHERE chat_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS quality_pending_actions_chat_session_id_idx
  ON quality_pending_actions (chat_session_id)
  WHERE chat_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS role_pending_actions_chat_session_id_idx
  ON role_pending_actions (chat_session_id)
  WHERE chat_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS site_defaults_pending_actions_chat_session_id_idx
  ON site_defaults_pending_actions (chat_session_id)
  WHERE chat_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS snapshot_revert_pending_actions_chat_session_id_idx
  ON snapshot_revert_pending_actions (chat_session_id)
  WHERE chat_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS template_pending_actions_chat_session_id_idx
  ON template_pending_actions (chat_session_id)
  WHERE chat_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS theme_pending_actions_chat_session_id_idx
  ON theme_pending_actions (chat_session_id)
  WHERE chat_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS user_pending_actions_chat_session_id_idx
  ON user_pending_actions (chat_session_id)
  WHERE chat_session_id IS NOT NULL;

-- chat_messages: cascaded from a deleted chat session.
CREATE INDEX IF NOT EXISTS subagent_runs_parent_message_id_idx
  ON subagent_runs (parent_message_id)
  WHERE parent_message_id IS NOT NULL;

-- roles: `roles.delete`.
CREATE INDEX IF NOT EXISTS user_roles_role_id_idx
  ON user_roles (role_id);
CREATE INDEX IF NOT EXISTS role_pending_actions_role_id_idx
  ON role_pending_actions (role_id)
  WHERE role_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS role_pending_actions_applied_role_id_idx
  ON role_pending_actions (applied_role_id)
  WHERE applied_role_id IS NOT NULL;

-- themes: an approved theme deletion (`themes.execute_proposal`).
CREATE INDEX IF NOT EXISTS theme_pending_actions_theme_id_idx
  ON theme_pending_actions (theme_id)
  WHERE theme_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS theme_pending_actions_applied_theme_id_idx
  ON theme_pending_actions (applied_theme_id)
  WHERE applied_theme_id IS NOT NULL;

-- domains: `domains.remove`.
CREATE INDEX IF NOT EXISTS domain_pending_actions_domain_id_idx
  ON domain_pending_actions (domain_id)
  WHERE domain_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS domain_pending_actions_applied_domain_id_idx
  ON domain_pending_actions (applied_domain_id)
  WHERE applied_domain_id IS NOT NULL;

-- plugins: uninstall deletes the plugin row, cascading to its errors.
CREATE INDEX IF NOT EXISTS plugin_pending_actions_plugin_id_idx
  ON plugin_pending_actions (plugin_id)
  WHERE plugin_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS image_requests_plugin_id_idx
  ON image_requests (plugin_id)
  WHERE plugin_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS plugin_errors_plugin_id_idx
  ON plugin_errors (plugin_id)
  WHERE plugin_id IS NOT NULL;
-- The grants' unique index is partial (`revoked_at IS NULL`); the
-- cascade from a deleted installation version also reaches revoked ones.
CREATE INDEX IF NOT EXISTS plugin_capability_grants_version_idx
  ON plugin_capability_grants (plugin_id, artifact_digest);
CREATE INDEX IF NOT EXISTS plugin_runtime_error_id_idx
  ON plugin_runtime (error_id)
  WHERE error_id IS NOT NULL;

COMMIT;
