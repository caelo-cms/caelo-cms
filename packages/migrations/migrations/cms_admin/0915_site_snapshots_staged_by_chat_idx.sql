-- SPDX-License-Identifier: MPL-2.0
-- caelo:no-transaction
--
-- 0915 — a chat lists what it staged until Publish live ships it (#1750).
--
-- `chat.list_pending_changes` names a chat's staged changes: the snapshot
-- headers its Stages merged (`staged_at` set) since the staging build live
-- was copied from, newest first (by `staged_at`, then by write: one Stage
-- stamps all of its headers with one time), at most a page of them. The
-- two indexes serve that read by the chat, so it costs the page it lists,
-- never the chat's whole history or the site's:
--
--   - by task: a shared-draft chat's headers carry its own task (or a
--     subagent's); the draft branch itself would read every chat's;
--   - by branch: an isolated branch belongs to its chat, whoever wrote on
--     it.
--
-- Partial: pending headers (`staged_at IS NULL`) are never in the list.
-- Built CONCURRENTLY outside a transaction (`caelo:no-transaction`, as in
-- 0705): site_snapshots grows with every write, and a plain CREATE INDEX
-- would stall every write of the running admin during the upgrade. Each
-- index is dropped first, because an interrupted CONCURRENTLY build leaves
-- an INVALID index that `IF NOT EXISTS` would keep.
--
-- Expand-only: indexes the previous release does not use.

DROP INDEX CONCURRENTLY IF EXISTS site_snapshots_task_staged_idx;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY site_snapshots_task_staged_idx
  ON site_snapshots (chat_task_id, staged_at DESC, created_at DESC)
  WHERE staged_at IS NOT NULL AND chat_task_id IS NOT NULL;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS site_snapshots_branch_staged_idx;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY site_snapshots_branch_staged_idx
  ON site_snapshots (chat_branch_id, staged_at DESC, created_at DESC)
  WHERE staged_at IS NOT NULL AND chat_branch_id IS NOT NULL;
