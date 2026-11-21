-- Epic #1644 (R2 #1648, R3 #1649) — the collections of the pointed release.
--
-- One row per active plugin's collection: the release file in this
-- environment's collection store that the gateway searches. Published with
-- the `plugins` section from the run the environment's pointer names (the
-- admin's collection_releases, 0721), so a collection goes live exactly when
-- its Stage does, and a rollback points back. The gateway may only read it.
--
-- Expand-only: a new table the previous release does not read.

CREATE TABLE IF NOT EXISTS published_collections (
  plugin_id   uuid NOT NULL,
  collection  text NOT NULL CHECK (collection ~ '^[a-z][a-z0-9_]{0,39}$'),
  release_key text NOT NULL CHECK (length(release_key) <= 900),
  PRIMARY KEY (plugin_id, collection)
);

ALTER TABLE published_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE published_collections FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS published_collections_publisher ON published_collections;
CREATE POLICY published_collections_publisher ON published_collections TO admin_role
  USING (caelo_setting_is('caelo.actor_kind', 'system'))
  WITH CHECK (caelo_setting_is('caelo.actor_kind', 'system'));
DROP POLICY IF EXISTS published_collections_gateway_read ON published_collections;
CREATE POLICY published_collections_gateway_read ON published_collections
  FOR SELECT TO public_role USING (true);
GRANT SELECT ON published_collections TO public_role;
