-- SPDX-License-Identifier: MPL-2.0
--
-- 0345 — issue #1008: every admin instance follows the plugin decisions in
-- the database, not only the one that handled the change.
--
-- An activation, disable, uninstall or revoked grant used to reach only the
-- instance that ran the op (the post-commit host sync). Other instances kept
-- what they had loaded at boot: on 2026-10-22 one instance still ran a
-- plugin the database no longer had active, and its preview broke.
--
-- 1. `plugin_host_generation` counts changes to the rows a plugin's
--    runnability depends on. Triggers bump it on every write, by any
--    writer — an op, a migration, a manual repair — so nothing can change
--    plugin state without the instances noticing. Each instance compares
--    the counter (cheaply, throttled, before requests and on a timer) and,
--    when it moved, reconciles what it runs with the rows (plugin-host
--    `reconcile.ts`). A sequence, not a table: no row to lock and no RLS
--    to route around; a bump left behind by a rolled-back write only
--    causes one reconcile that changes nothing.
--
--    Row triggers, not statement triggers: a statement trigger also fires
--    for a write that changed no row, and every load attempt runs the
--    loader's plugins upsert. Instances retrying a failing plugin would
--    then keep waking each other up. The loader's upsert only changes the
--    row when the release actually differs, so only real changes count.
--
-- 2. `deploy_runs.plugin_problems` — the active plugins that were not
--    running when a build ran. A Stage built without one of them renders
--    the site without its contribution (localized links, consent banner,
--    …); Publish live refuses to ship that build, even after the plugin
--    recovered (Stage again). NULL on runs from before this column.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE SEQUENCE plugin_host_generation;

CREATE OR REPLACE FUNCTION caelo_bump_plugin_host_generation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM nextval('plugin_host_generation');
  RETURN NULL;
END;
$$;

CREATE TRIGGER caelo_plugin_host_generation
  AFTER INSERT OR UPDATE OR DELETE ON plugins FOR EACH ROW
  EXECUTE FUNCTION caelo_bump_plugin_host_generation();
CREATE TRIGGER caelo_plugin_host_generation
  AFTER INSERT OR UPDATE OR DELETE ON plugin_installation_versions FOR EACH ROW
  EXECUTE FUNCTION caelo_bump_plugin_host_generation();
CREATE TRIGGER caelo_plugin_host_generation
  AFTER INSERT OR UPDATE OR DELETE ON plugin_capability_grants FOR EACH ROW
  EXECUTE FUNCTION caelo_bump_plugin_host_generation();

ALTER TABLE deploy_runs ADD COLUMN plugin_problems jsonb NULL
  CHECK (plugin_problems IS NULL OR jsonb_typeof(plugin_problems) = 'array');

COMMIT;
