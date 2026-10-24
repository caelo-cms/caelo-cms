-- SPDX-License-Identifier: MPL-2.0
--
-- 0345 — issue #1008: Publish live never ships a Stage that was built
-- without an active plugin.
--
-- `deploy_runs.plugin_problems` — the active plugins that were not running
-- when a build ran (`[{slug, reason}]`, `[]` when all ran). A Stage built
-- without one of them renders the site without its contribution (localized
-- links, consent banner, …); Publish live refuses to ship that build, even
-- after the plugin recovered (Stage again). NULL on runs from before this
-- column, which Publish live refuses too: whether they were complete was
-- never recorded.
--
-- How every admin instance learns that plugin rows changed needs no schema:
-- the reconciler (plugin-host `reconcile.ts`) fingerprints the plugin rows,
-- active installations and grants in the same statement that reads them.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE deploy_runs ADD COLUMN plugin_problems jsonb NULL
  CHECK (plugin_problems IS NULL OR jsonb_typeof(plugin_problems) = 'array');

COMMIT;
