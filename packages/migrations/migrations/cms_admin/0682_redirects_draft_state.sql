-- SPDX-License-Identifier: MPL-2.0
--
-- 0682 — issue #1550: redirects are draft state (Draft, Staged, Live, and
-- Go live now). Docs: docs/dev/redirects-and-settings-sync.md.
--
-- `redirects` keeps its meaning: the LIVE state, what the hosting provider
-- serves (the sync pushes exactly this table) and the projection publishes
-- as the live rows. Nothing writes it any more but Publish live, an
-- Owner's production build, Go live now, a rollback and the first-publish
-- take-over (scripts/no-draft-live-writes.test.ts pins them).
--
--   caelo_redirect_address(path)  the address a from path belongs to: the
--                                 path without its trailing slash, so `/x`
--                                 and `/x/` are one address (as the redirect
--                                 plan answers them). `redirects.address`
--                                 stores it, indexed, for the lookups by
--                                 address.
--   pending_redirects             at most one pending change per address: a
--                                 create or change (`to_path` set) or a
--                                 removal (`to_path` NULL), Draft or Staged,
--                                 manual or automatic (a page move, delete,
--                                 URL migration, revert, or a plugin; always
--                                 Staged). `revision` binds a Publish live
--                                 confirmation: a change saved after it is a
--                                 new revision and waits for the next one.
--                                 `chat_branch_id`: NULL or the shared draft
--                                 joins the staging view; an isolated branch
--                                 keeps its changes until its Stage merge.
--   redirect_release_log          every write of the live state, per
--                                 address: the live rules before and after
--                                 and the change applied (a release, its
--                                 first-publish take-over, Go live now, a
--                                 rollback). A rollback reconstructs from it
--                                 the live state as of the run it restores
--                                 and makes the rolled-back changes Staged
--                                 again; Go live now's changes stay live.
--
-- The staging view (live state plus the shared draft's Staged changes) is
-- published into cms_public_staging (`published_redirect_changes`, 0683):
-- a write of pending_redirects marks the `redirects` projection section.
--
-- The update itself creates no pending change and moves no row: existing
-- redirects stay live, visitors see no change. Expand-only: the previous
-- release (during the roll) keeps writing `redirects` directly and never
-- reads the new tables.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE OR REPLACE FUNCTION caelo_redirect_address(path text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$
    SELECT CASE WHEN length(path) > 1 THEN COALESCE(NULLIF(rtrim(path, '/'), ''), '/') ELSE path END
  $$;

-- The address as a stored column: a lookup by address must be an index
-- condition under the table's RLS policy, and an expression with rtrim()
-- (not leakproof) can never be one there. The previous release's INSERTs
-- name their columns, so the generated column fills itself during the roll.
ALTER TABLE redirects
  ADD COLUMN address text GENERATED ALWAYS AS (caelo_redirect_address(from_path)) STORED;
CREATE INDEX redirects_address_idx ON redirects (address);

CREATE TABLE pending_redirects (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  address         text NOT NULL UNIQUE
                  CHECK (address LIKE '/%' AND address = caelo_redirect_address(address)
                         AND length(address) <= 2048),
  from_path       text NOT NULL CHECK (caelo_redirect_address(from_path) = address),
  to_path         text NULL CHECK (to_path IS NULL OR length(to_path) <= 2048),
  status_code     int  NULL CHECK (status_code IS NULL OR status_code IN (301, 302, 307, 308, 410)),
  state           text NOT NULL CHECK (state IN ('draft', 'staged')),
  origin          text NOT NULL
                  CHECK (origin IN ('manual', 'page_move', 'page_delete', 'url_migration', 'revert', 'plugin')),
  revision        bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  actor_id        uuid NOT NULL REFERENCES actors(id),
  chat_session_id uuid NULL REFERENCES chat_sessions(id) ON DELETE SET NULL,
  chat_branch_id  uuid NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((to_path IS NULL) = (status_code IS NULL)),
  -- An automatic change goes live with the page change that caused it.
  CHECK (origin = 'manual' OR state = 'staged')
);
CREATE INDEX pending_redirects_state_idx ON pending_redirects (state, address);
CREATE INDEX pending_redirects_branch_idx ON pending_redirects (chat_branch_id);
CREATE INDEX pending_redirects_chat_idx ON pending_redirects (chat_session_id);
CREATE INDEX pending_redirects_actor_idx ON pending_redirects (actor_id);
CREATE INDEX pending_redirects_to_path_idx ON pending_redirects (to_path);

CREATE TABLE redirect_release_log (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The run that wrote: a Publish live, an Owner's production build, a
  -- rollback. NULL for Go live now.
  run_id                 uuid NULL REFERENCES deploy_runs(id) ON DELETE CASCADE,
  kind                   text NOT NULL
                         CHECK (kind IN ('release', 'take_over', 'go_live_now', 'rollback')),
  address                text NOT NULL CHECK (address LIKE '/%'),
  -- The live rules of the address before and after the write: every
  -- stored spelling (`/x` and `/x/` of an imported table), as
  -- [{fromPath, toPath, statusCode}].
  before_rules           jsonb NOT NULL CHECK (jsonb_typeof(before_rules) = 'array'),
  after_rules            jsonb NOT NULL CHECK (jsonb_typeof(after_rules) = 'array'),
  -- The change applied, so a rollback re-stages it as it was. A rollback
  -- applies none.
  origin                 text NULL
                         CHECK (origin IN ('manual', 'page_move', 'page_delete', 'url_migration', 'revert', 'plugin')),
  change_actor_id        uuid NULL REFERENCES actors(id),
  change_chat_session_id uuid NULL REFERENCES chat_sessions(id) ON DELETE SET NULL,
  applied_by             uuid NOT NULL REFERENCES actors(id),
  applied_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((kind = 'go_live_now') = (run_id IS NULL)),
  CHECK ((kind = 'rollback') = (origin IS NULL)),
  CHECK ((kind = 'rollback') = (change_actor_id IS NULL))
);
CREATE INDEX redirect_release_log_run_idx ON redirect_release_log (run_id);
CREATE INDEX redirect_release_log_applied_idx ON redirect_release_log (applied_at);
CREATE INDEX redirect_release_log_address_idx ON redirect_release_log (address, applied_at DESC);
CREATE INDEX redirect_release_log_change_actor_idx ON redirect_release_log (change_actor_id);
CREATE INDEX redirect_release_log_change_chat_idx ON redirect_release_log (change_chat_session_id);
CREATE INDEX redirect_release_log_applied_by_idx ON redirect_release_log (applied_by);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pending_redirects', 'redirect_release_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    -- Any authenticated actor session; who may write what is decided at the op.
    EXECUTE format(
      'CREATE POLICY %I ON %I '
      'USING (NULLIF(current_setting(''caelo.actor_kind'', true), '''') IS NOT NULL) '
      'WITH CHECK (NULLIF(current_setting(''caelo.actor_kind'', true), '''') IS NOT NULL)',
      t || '_authenticated_scope', t);
  END LOOP;
END $$;

-- The editor's `draft` topic and every journal consumer see a pending
-- change the moment it commits; the branch is the change's own.
SELECT caelo_journal_attach('pending_redirects', 'pending_redirect', 'id', 'row', 'id', '',
                            'chat_branch_id');

-- The staging view follows every pending change (0683 publishes it).
DROP TRIGGER IF EXISTS caelo_projection_pending_redirects ON pending_redirects;
CREATE TRIGGER caelo_projection_pending_redirects
  AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON pending_redirects FOR EACH STATEMENT
  EXECUTE FUNCTION caelo_mark_public_projection('redirects');

-- The provider sync pushes the live table to production only: staging is
-- served by the staging gateway from cms_public_staging (#1330). A staging
-- row left behind would be retried forever. Go live now is a trigger of
-- its own in the history.
DELETE FROM redirect_sync_state
WHERE target_id IN (SELECT id FROM deploy_targets WHERE env <> 'production');
ALTER TABLE redirect_syncs DROP CONSTRAINT IF EXISTS redirect_syncs_trigger_check;
ALTER TABLE redirect_syncs
  ADD CONSTRAINT redirect_syncs_trigger_check
  CHECK (trigger IN ('save', 'build', 'publish', 'rollback', 'retry', 'manual', 'go_live'));

-- The AI's Go live now is a §11.A proposal (redirects.propose_go_live).
ALTER TABLE redirect_pending_actions DROP CONSTRAINT IF EXISTS redirect_pending_actions_kind_check;
ALTER TABLE redirect_pending_actions
  ADD CONSTRAINT redirect_pending_actions_kind_check CHECK (kind IN ('set_external', 'go_live_now'));

COMMIT;
