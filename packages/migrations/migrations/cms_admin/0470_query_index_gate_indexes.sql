-- SPDX-License-Identifier: MPL-2.0
--
-- 0470 — issue #1293: the indexes the query index gate's first run found
-- missing outside the core-index (#1291) and plugin-index (#1292) work.
-- Each one turns a full scan of a growing table into an index lookup
-- (docs/dev/query-index-gate.md). Expand-only.
--
--   lists (slug)                  lists.get / upsert_many / patch_items_many /
--                                 delete_many / promote_local resolve slugs
--                                 including soft-deleted rows, which the
--                                 partial unique index (WHERE deleted_at IS
--                                 NULL) cannot serve.
--   chat_entity_locks (chat_branch_id)
--                                 a branch's publish / discard / undo / archive
--                                 releases the branch's locks.
--   ai_bug_reports (kind, created_at)
--                                 the bug-report list filtered by kind.
--   plugin_tool_approval_bindings (created_at)
--                                 the binding GC every recorded binding runs.
--   quality_audit_runs (created_at DESC) WHERE publish_override_by IS NOT NULL
--                                 the audit list's "published anyway" filter,
--                                 newest first.
--   subagent_runs (finished_at) WHERE finished_at IS NOT NULL
--                                 the GC of finished subagent sessions.
--
-- (The open-chat lists the first run also found are served by 0434's
-- chat_sessions_open_activity_idx, #1268.)

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE INDEX IF NOT EXISTS lists_slug_idx ON lists (slug);

CREATE INDEX IF NOT EXISTS chat_entity_locks_branch_idx ON chat_entity_locks (chat_branch_id);

CREATE INDEX IF NOT EXISTS ai_bug_reports_kind_idx ON ai_bug_reports (kind, created_at);

CREATE INDEX IF NOT EXISTS plugin_tool_approval_bindings_created_idx
  ON plugin_tool_approval_bindings (created_at);

CREATE INDEX IF NOT EXISTS quality_audit_runs_override_idx
  ON quality_audit_runs (created_at DESC)
  WHERE publish_override_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS subagent_runs_finished_idx
  ON subagent_runs (finished_at)
  WHERE finished_at IS NOT NULL;

COMMIT;
