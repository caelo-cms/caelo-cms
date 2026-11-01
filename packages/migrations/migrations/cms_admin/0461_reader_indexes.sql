-- SPDX-License-Identifier: MPL-2.0
--
-- 0461 — issue #1291: partial indexes whose predicate the queries do not
-- carry, and readers with no index at all.
--
-- A partial index serves a query only when the query's WHERE implies the
-- index predicate. Postgres's own FK checks (`$1 = col`) imply only
-- `col IS NOT NULL`, so an index restricted to `deleted_at IS NULL` never
-- serves them, nor a reader that also wants deleted rows. The two
-- `deleted_at` partial indexes below are replaced by `IS NOT NULL` ones
-- (deleted rows are few, so live readers lose nothing measurable).
--
-- Plain CREATE INDEX: the runner wraps each file in a transaction
-- (runner.ts), where CONCURRENTLY cannot run.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

-- pages.parent_page_id: the FK check on a page delete and readers that
-- include deleted children.
CREATE INDEX IF NOT EXISTS pages_parent_page_id_idx
  ON pages (parent_page_id)
  WHERE parent_page_id IS NOT NULL;
DROP INDEX IF EXISTS pages_parent_page_idx;

-- content_instances.module_id: the FK cascade on a module delete and
-- `lists/local.ts` (instances of a module set, deleted ones included so
-- the branch overlay can see a deletion). The (module_id, slug, …) unique
-- index only covers rows with a slug.
CREATE INDEX IF NOT EXISTS content_instances_module_id_idx
  ON content_instances (module_id);
DROP INDEX IF EXISTS content_instances_module_idx;

-- sessions: step-up (`ops/step-up.ts`, `security/step-up/gate.ts`) finds
-- the browser session by `encode(sha256(convert_to(token…)))` AND
-- user_id; signing a user out deletes by user_id. The hash expression
-- cannot be indexed (convert_to is STABLE), so the user_id index narrows
-- the lookup to that user's few sessions. Also the users FK (CASCADE).
CREATE INDEX IF NOT EXISTS sessions_user_id_idx
  ON sessions (user_id);

-- subagent_runs.subagent_chat_session_id: the import cost-ceiling check
-- (`ops/imports.ts`) reads it at every subagent step, and the subagent
-- session GC (`subagent_runs.gc_old_sessions`) cascades through it.
CREATE INDEX IF NOT EXISTS subagent_runs_subagent_session_idx
  ON subagent_runs (subagent_chat_session_id);

-- The chat-image GC (`chat-image-gc-worker.ts`) periodically reads every
-- message with attachments; most messages have none.
CREATE INDEX IF NOT EXISTS chat_messages_with_attachments_idx
  ON chat_messages (created_at)
  WHERE attachments IS NOT NULL;

-- import_pages.accepted_page_id: `resolveImportPageRef`
-- (`ops/imports.ts`, `id = $1 OR accepted_page_id = $1`, a BitmapOr with
-- the pkey) and the accepted-page count.
CREATE INDEX IF NOT EXISTS import_pages_accepted_page_idx
  ON import_pages (accepted_page_id)
  WHERE accepted_page_id IS NOT NULL;

-- chat_lock_takeovers: the chat's takeover list
-- (`ops/chat/open-changes.ts`, `to_chat_session_id = $1 OR
-- from_chat_session_id = $1`), which the `…_notified_at IS NULL` partial
-- indexes cannot serve, and the chat_sessions FKs the subagent session GC
-- deletes through. (The `(entity_kind, entity_id)` lookups the audit saw
-- are test assertions only; no production reader, so no index.)
CREATE INDEX IF NOT EXISTS chat_lock_takeovers_from_session_idx
  ON chat_lock_takeovers (from_chat_session_id)
  WHERE from_chat_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS chat_lock_takeovers_to_session_idx
  ON chat_lock_takeovers (to_chat_session_id);

COMMIT;
