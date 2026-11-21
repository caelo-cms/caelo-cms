-- Epic #1644 (R1 #1647, R2 #1648) — plugin collections and page output.
--
-- collection_changes        what plugins wrote to their collections, waiting
--                           for an index: one row per change file in the
--                           staging collection store (upserts and deletes,
--                           deflated JSON). `run_id` is the Stage whose index
--                           takes it (set at once for an observer's write, set
--                           by the next Stage for every other write);
--                           `applied_run_id` the Stage whose ready release
--                           holds it. A change of a failed index stays
--                           unapplied, and the next Stage takes it again.
-- collection_releases       one row per Stage run and collection: the release
--                           file the indexing job wrote (`ready`), or that it
--                           is still building (`pending`) or failed. The
--                           gateway learns a pointed run's ready releases
--                           through the projection (0722); Publish live
--                           copies their files to the live store first and
--                           refuses a run whose release is not ready.
-- plugin_page_observations  per observing plugin and page, the hashes of the
--                           output it last received, so a Stage sends only
--                           what changed. Derived from Stage output: losing it
--                           only re-sends pages.
-- plugin_page_observation_pending  what a running Stage delivered; moved into
--                           the table above when the Stage succeeds, dropped
--                           when it fails, so a failed build never marks a
--                           page as seen.
-- plugin_module_counts      per observing plugin, the placement counts it last
--                           received, to report changes (with a pending twin).
-- plugin_page_observers     per observing plugin, the digest of what shapes
--                           its view of every page (its version, its
--                           configuration, its module settings): a new
--                           digest makes the next Stage deliver every page
--                           again (with a pending twin).
--
-- Expand-only: new tables the previous release does not read.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE collection_changes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_id   uuid NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  collection  text NOT NULL CHECK (collection ~ '^[a-z][a-z0-9_]{0,39}$'),
  run_id      uuid REFERENCES deploy_runs(id) ON DELETE SET NULL,
  applied_run_id uuid REFERENCES deploy_runs(id) ON DELETE SET NULL,
  store_key   text NOT NULL,
  upserts     int NOT NULL CHECK (upserts >= 0),
  deletes     int NOT NULL CHECK (deletes >= 0),
  -- A batch's full replacement: every document not in it is deleted.
  replace_all boolean NOT NULL DEFAULT false,
  bytes       int NOT NULL CHECK (bytes >= 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX collection_changes_plugin_idx ON collection_changes (plugin_id, collection, created_at);
CREATE INDEX collection_changes_run_idx ON collection_changes (run_id);
CREATE INDEX collection_changes_applied_idx ON collection_changes (applied_run_id);
CREATE INDEX collection_changes_unapplied_idx ON collection_changes (plugin_id, collection, created_at)
  WHERE applied_run_id IS NULL;

CREATE TABLE collection_releases (
  run_id          uuid NOT NULL REFERENCES deploy_runs(id) ON DELETE CASCADE,
  plugin_id       uuid NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  collection      text NOT NULL CHECK (collection ~ '^[a-z][a-z0-9_]{0,39}$'),
  state           text NOT NULL CHECK (state IN ('pending', 'ready', 'failed')),
  release_key     text,
  previous_run_id uuid REFERENCES deploy_runs(id) ON DELETE SET NULL,
  stats           jsonb NOT NULL DEFAULT '{}'::jsonb,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  PRIMARY KEY (run_id, plugin_id, collection),
  CHECK ((state = 'ready') = (release_key IS NOT NULL))
);
CREATE INDEX collection_releases_plugin_idx ON collection_releases (plugin_id, collection, created_at DESC);
CREATE INDEX collection_releases_previous_idx ON collection_releases (previous_run_id);

CREATE TABLE plugin_page_observations (
  plugin_id  uuid NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  -- No foreign key: a deleted page's row is what tells the observer it is gone.
  page_id    uuid NOT NULL,
  html_hash  text NOT NULL,
  facts_hash text NOT NULL,
  PRIMARY KEY (plugin_id, page_id)
);

CREATE TABLE plugin_page_observation_pending (
  run_id     uuid NOT NULL REFERENCES deploy_runs(id) ON DELETE CASCADE,
  plugin_id  uuid NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  page_id    uuid NOT NULL,
  html_hash  text,
  facts_hash text,
  -- True: the page left the build; the commit deletes its observation.
  removed    boolean NOT NULL DEFAULT false,
  PRIMARY KEY (run_id, plugin_id, page_id),
  CHECK (removed OR (html_hash IS NOT NULL AND facts_hash IS NOT NULL))
);
CREATE INDEX plugin_page_observation_pending_plugin_idx ON plugin_page_observation_pending (plugin_id);

CREATE TABLE plugin_module_counts (
  plugin_id       uuid NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  module_id       uuid NOT NULL,
  placement_count int NOT NULL CHECK (placement_count >= 0),
  PRIMARY KEY (plugin_id, module_id)
);

CREATE TABLE plugin_module_count_pending (
  run_id          uuid NOT NULL REFERENCES deploy_runs(id) ON DELETE CASCADE,
  plugin_id       uuid NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  module_id       uuid NOT NULL,
  placement_count int NOT NULL CHECK (placement_count >= 0),
  PRIMARY KEY (run_id, plugin_id, module_id)
);
CREATE INDEX plugin_module_count_pending_plugin_idx ON plugin_module_count_pending (plugin_id);

CREATE TABLE plugin_page_observers (
  plugin_id uuid PRIMARY KEY REFERENCES plugins(id) ON DELETE CASCADE,
  digest    text NOT NULL
);

CREATE TABLE plugin_page_observer_pending (
  run_id    uuid NOT NULL REFERENCES deploy_runs(id) ON DELETE CASCADE,
  plugin_id uuid NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  digest    text NOT NULL,
  PRIMARY KEY (run_id, plugin_id)
);
CREATE INDEX plugin_page_observer_pending_plugin_idx ON plugin_page_observer_pending (plugin_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'collection_changes', 'collection_releases', 'plugin_page_observations',
    'plugin_page_observation_pending', 'plugin_module_counts', 'plugin_module_count_pending',
    'plugin_page_observers', 'plugin_page_observer_pending'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    -- System bookkeeping of the build: only the host's system operations touch it.
    EXECUTE format(
      'CREATE POLICY %I ON %I '
      'USING (caelo_setting_is(''caelo.actor_kind'', ''system'')) '
      'WITH CHECK (caelo_setting_is(''caelo.actor_kind'', ''system''))',
      t || '_system_scope', t);
  END LOOP;
END $$;

-- A plugin reaches its own collection rows only (caelo.plugin_id, set by the
-- adapter for a plugin actor): it appends changes and reads its releases.
CREATE POLICY collection_changes_own_plugin ON collection_changes FOR INSERT
  WITH CHECK (caelo_setting_is('caelo.actor_kind', 'plugin') AND (plugin_id)::text = current_setting('caelo.plugin_id', true));
CREATE POLICY collection_changes_own_plugin_read ON collection_changes FOR SELECT
  USING (caelo_setting_is('caelo.actor_kind', 'plugin') AND (plugin_id)::text = current_setting('caelo.plugin_id', true));
-- Which index a Stage built is no secret: every authenticated actor reads it
-- (the Stage status, Publish live's gate, the plugin itself); only the
-- system writes it.
CREATE POLICY collection_releases_authenticated_read ON collection_releases FOR SELECT
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

-- A collection release of a pointed run that becomes ready (or is replaced)
-- republishes the release section, so the gateway learns the new index.
DROP TRIGGER IF EXISTS caelo_projection_collections ON collection_releases;
CREATE TRIGGER caelo_projection_collections
  AFTER INSERT OR UPDATE OR DELETE ON collection_releases FOR EACH STATEMENT
  EXECUTE FUNCTION caelo_mark_public_projection('plugins');

COMMIT;
