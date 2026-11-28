-- SPDX-License-Identifier: MPL-2.0
--
-- 0950 — data imports: one way in for every kind of data from another
-- system (comments, rating totals, redirects, …). The AI is the adapter to
-- the source; Caelo knows only each kind's target shape. Docs:
-- docs/data-imports.md.
--
--   data_uploads       a file handed over for an import (CSV, JSON Lines,
--                      JSON), kept in the private media store for at most
--                      7 days. `awaiting` is a slot an operator fills on
--                      the admin page a remote MCP client links to.
--   data_imports       one import run: its kind, where the data came from,
--                      who ran it in which chat, its last report and its
--                      release stamps (below).
--   data_import_items  every row an import holds. The id is derived from
--                      the import and the row's `sourceKey`, so a retry of
--                      a call writes the same target rows again instead of
--                      new ones. One active row per (owner, kind,
--                      sourceKey): a later run finds what an earlier one
--                      holds and leaves it, until that import is undone.
--
-- Release (kinds with release 'stage'): an import is a draft until the
-- Stage that ships its chat. That Stage's merge sets `merged_at`; the next
-- build to start (deploy.start_trigger, either environment) stamps
-- `staged_run_id` / `staged_since` = that run's start. An environment shows
-- an import while the run its release pointer names started at or after
-- `staged_since`, and stops showing it from the run that started at or
-- after `undo_staged_since`. A rollback only moves the pointer, so it takes
-- imports back with their release and needs no logic of its own.
--
-- `comment_archive.data_import_id` marks imported comments. The projection
-- publishes each to the public databases whose pointer shows its import;
-- when a pointer moves, the trigger below queues the comments of every
-- import whose visibility the move changed.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE data_uploads (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by       uuid NOT NULL REFERENCES actors(id),
  chat_session_id  uuid NULL REFERENCES chat_sessions(id) ON DELETE SET NULL,
  status           text NOT NULL CHECK (status IN ('awaiting', 'ready')),
  filename         text NULL CHECK (filename IS NULL OR length(filename) BETWEEN 1 AND 255),
  format           text NULL CHECK (format IS NULL OR format IN ('csv', 'jsonl', 'json')),
  byte_size        integer NULL CHECK (byte_size IS NULL OR byte_size > 0),
  sha256           text NULL CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  storage_key      text NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  uploaded_at      timestamptz NULL,
  expires_at       timestamptz NOT NULL,
  CHECK ((status = 'ready') = (storage_key IS NOT NULL)),
  CHECK ((status = 'ready') = (uploaded_at IS NOT NULL)),
  CHECK (status = 'awaiting' OR (filename IS NOT NULL AND format IS NOT NULL
                                 AND byte_size IS NOT NULL AND sha256 IS NOT NULL))
);
CREATE INDEX data_uploads_created_by_idx ON data_uploads (created_by, created_at DESC);
CREATE INDEX data_uploads_chat_session_idx ON data_uploads (chat_session_id);
CREATE INDEX data_uploads_expires_idx ON data_uploads (expires_at);

CREATE TABLE data_imports (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 'core' or the owning plugin's slug.
  owner                 text NOT NULL CHECK (owner ~ '^(core|[a-z][a-z0-9-]{0,63})$'),
  kind                  text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]{1,39}$'),
  release               text NOT NULL CHECK (release IN ('stage', 'target')),
  -- Where the rows came from, in the operator's words ("WordPress example.com").
  source_label          text NOT NULL CHECK (length(source_label) BETWEEN 1 AND 120),
  created_by            uuid NOT NULL REFERENCES actors(id),
  chat_session_id       uuid NULL REFERENCES chat_sessions(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  item_count            integer NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  -- The report of the last call that added to this import (ImportReport).
  last_report           jsonb NULL,
  merged_at             timestamptz NULL,
  staged_run_id         uuid NULL REFERENCES deploy_runs(id),
  staged_since          timestamptz NULL,
  undone_at             timestamptz NULL,
  undone_by             uuid NULL REFERENCES actors(id),
  undo_chat_session_id  uuid NULL REFERENCES chat_sessions(id) ON DELETE SET NULL,
  undo_merged_at        timestamptz NULL,
  undo_staged_run_id    uuid NULL REFERENCES deploy_runs(id),
  undo_staged_since     timestamptz NULL,
  CHECK ((staged_run_id IS NULL) = (staged_since IS NULL)),
  CHECK ((undo_staged_run_id IS NULL) = (undo_staged_since IS NULL)),
  CHECK (staged_since IS NULL OR merged_at IS NOT NULL),
  CHECK (undo_merged_at IS NULL OR undone_at IS NOT NULL),
  CHECK (undo_staged_since IS NULL OR (undo_merged_at IS NOT NULL AND staged_since IS NOT NULL)),
  CHECK (release = 'stage' OR (merged_at IS NULL AND undo_merged_at IS NULL))
);
CREATE INDEX data_imports_kind_idx ON data_imports (kind, created_at DESC);
CREATE INDEX data_imports_created_idx ON data_imports (created_at DESC);
CREATE INDEX data_imports_chat_session_idx ON data_imports (chat_session_id);
CREATE INDEX data_imports_undo_chat_session_idx ON data_imports (undo_chat_session_id);
CREATE INDEX data_imports_staged_run_idx ON data_imports (staged_run_id);
CREATE INDEX data_imports_undo_staged_run_idx ON data_imports (undo_staged_run_id);
CREATE INDEX data_imports_staged_since_idx ON data_imports (staged_since);
CREATE INDEX data_imports_undo_staged_since_idx ON data_imports (undo_staged_since);
-- The build stamps what the Stage merges and no build carries yet.
CREATE INDEX data_imports_unstamped_idx ON data_imports (merged_at)
  WHERE staged_since IS NULL;
CREATE INDEX data_imports_undo_unstamped_idx ON data_imports (undo_merged_at)
  WHERE undo_staged_since IS NULL;

CREATE TABLE data_import_items (
  row_id         uuid PRIMARY KEY,
  import_id      uuid NOT NULL REFERENCES data_imports(id) ON DELETE CASCADE,
  owner          text NOT NULL,
  kind           text NOT NULL,
  source_key     text NOT NULL CHECK (length(source_key) BETWEEN 1 AND 200),
  parent_row_id  uuid NULL,
  -- The page a `pageRef` field resolved to. No foreign key, like
  -- comment_archive.page_id: a page can be a chat's branch row or go away,
  -- and its imported rows then simply belong to no page that renders.
  page_id        uuid NULL,
  "values"       jsonb NOT NULL,
  -- sha256 of the checked values: tells an unchanged row from an update.
  digest         text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  -- What the kind calls the stored row, when it names it (a redirect's
  -- address); an undo hands it back to the kind.
  target_ref     text NULL,
  -- False once the import is undone. The rows stay (an environment may
  -- still show them until the undo goes live, and a rollback can bring
  -- them back), but the key is free for a new import.
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX data_import_items_import_idx ON data_import_items (import_id, row_id);
CREATE INDEX data_import_items_kind_idx ON data_import_items (owner, kind, row_id);
CREATE UNIQUE INDEX data_import_items_active_key_idx ON data_import_items (owner, kind, source_key)
  WHERE active;
CREATE INDEX data_import_items_page_idx ON data_import_items (page_id);

-- No foreign key: the content wipe (packages/migrations/src/truncate.ts)
-- truncates data_imports with CASCADE, which would take every visitor
-- comment with it. A comment whose import row is gone reads as an import
-- no environment shows.
ALTER TABLE comment_archive ADD COLUMN IF NOT EXISTS data_import_id uuid NULL;
CREATE INDEX IF NOT EXISTS comment_archive_data_import_idx ON comment_archive (data_import_id);

-- A `pageRef` given as a URL of the old site finds the page a site import
-- built from it.
CREATE INDEX IF NOT EXISTS import_pages_source_url_idx ON import_pages (source_url);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['data_uploads', 'data_imports', 'data_import_items'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I '
      'USING (NULLIF(current_setting(''caelo.actor_kind'', true), '''') IS NOT NULL) '
      'WITH CHECK (NULLIF(current_setting(''caelo.actor_kind'', true), '''') IS NOT NULL)',
      t || '_authenticated_scope', t);
  END LOOP;
END $$;

/**
 * Trigger on projection_release_pointers: when an environment's pointer
 * moves, the imports stamped between the old and the new run's start
 * change visibility there. Queue their comments for the projection, which
 * publishes or withdraws each by the new pointer. Only comments need
 * this: they are core rows the projection publishes, while plugin kinds
 * read their rows through the host by the same rule whenever they run.
 */
CREATE OR REPLACE FUNCTION caelo_data_import_pointer_moved() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  old_start timestamptz := '-infinity';
  new_start timestamptz;
  lo timestamptz;
  hi timestamptz;
BEGIN
  SELECT started_at INTO new_start FROM deploy_runs WHERE id = NEW.run_id;
  IF TG_OP = 'UPDATE' THEN
    SELECT started_at INTO old_start FROM deploy_runs WHERE id = OLD.run_id;
    old_start := COALESCE(old_start, '-infinity');
  END IF;
  IF new_start IS NULL OR new_start = old_start THEN
    RETURN NULL;
  END IF;
  lo := LEAST(old_start, new_start);
  hi := GREATEST(old_start, new_start);
  INSERT INTO public_projection_outbox (section, entity_id)
  SELECT 'comments', ca.id
  FROM data_imports di
  JOIN comment_archive ca ON ca.data_import_id = di.id
  WHERE di.id IN (
    SELECT id FROM data_imports WHERE staged_since > lo AND staged_since <= hi
    UNION
    SELECT id FROM data_imports WHERE undo_staged_since > lo AND undo_staged_since <= hi
  );
  IF FOUND THEN
    PERFORM set_config('caelo.projection_dirty', 'on', true);
  END IF;
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS caelo_data_import_pointer_moved ON projection_release_pointers;
CREATE TRIGGER caelo_data_import_pointer_moved
  AFTER INSERT OR UPDATE OF run_id ON projection_release_pointers FOR EACH ROW
  EXECUTE FUNCTION caelo_data_import_pointer_moved();

COMMIT;
