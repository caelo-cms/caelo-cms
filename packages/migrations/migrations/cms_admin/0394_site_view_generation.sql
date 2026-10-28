-- SPDX-License-Identifier: MPL-2.0
--
-- 0394 — the generation of the site view a preview renders against
-- (issue #1212, epic #1209).
--
-- Every editor preview needs the whole site as the chat sees it: every
-- page (lists, the link index, breadcrumbs), every page's SEO summary,
-- every media asset, the list types, lists and page types. Re-reading all
-- of it per render made the preview's cost grow with the site. The admin
-- now keeps that view in memory per branch, keyed by this counter, and
-- re-reads it only when the counter moved.
--
-- The counter moves with every COMMITTED change to a table the view reads,
-- whoever made it (an op, a Stage, an undo, a migration, a psql session,
-- another admin instance), so no edit can leave a preview stale:
--
--   - a deferred constraint trigger bumps it at commit time, inside the
--     writing transaction: a reader sees the new counter exactly when it
--     sees the change (a rollback leaves both untouched);
--   - deferred, so the counter row is locked only for the instant between
--     the trigger and the commit — not for the whole writing transaction,
--     which would serialise every chat write behind a running Stage;
--   - once per transaction (a transaction-local flag), however many rows
--     the transaction wrote;
--   - TRUNCATE (the content reset, the test reset) bumps it directly.
--
-- Tables: pages, page_terms, pages_seo, media_assets, site_defaults; the
-- list entities and their snapshots; site_snapshots / page_snapshots
-- (a chat's pending page edits, and their staging or undo); and the
-- plugin rows `plugin_list_type_available` reads.
--
-- Expand-only (#696): a new table, function and triggers.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE site_view_generation (
  id         smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  generation bigint NOT NULL DEFAULT 0
);
INSERT INTO site_view_generation DEFAULT VALUES;

ALTER TABLE site_view_generation ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_view_generation FORCE ROW LEVEL SECURITY;
-- The counter carries no data, only "something changed". Every writer
-- bumps it — whatever actor it acts for, including a session with no
-- actor at all (a migration, a fixture): a policy that filtered such a
-- session would silently skip the bump and leave previews stale.
CREATE POLICY site_view_generation_read ON site_view_generation FOR SELECT USING (true);
CREATE POLICY site_view_generation_bump ON site_view_generation FOR UPDATE
  USING (true) WITH CHECK (true);

/** Bump the generation once per transaction (see the header). */
CREATE FUNCTION caelo_bump_site_view_generation() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_LEVEL = 'ROW' AND current_setting('caelo.site_view_bumped', true) = 'on' THEN
    RETURN NULL;
  END IF;
  UPDATE site_view_generation SET generation = generation + 1 WHERE id = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'site_view_generation row (id=1) is missing — migration 0394 seeds it';
  END IF;
  PERFORM set_config('caelo.site_view_bumped', 'on', true);
  RETURN NULL;
END
$fn$;

DO $do$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'pages', 'page_terms', 'pages_seo', 'media_assets', 'site_defaults',
    'list_types', 'lists', 'page_types',
    'list_type_snapshots', 'list_snapshots', 'page_type_snapshots',
    'site_snapshots', 'page_snapshots',
    'plugins', 'plugin_installation_versions', 'plugin_capability_grants'
  ] LOOP
    EXECUTE format(
      'CREATE CONSTRAINT TRIGGER caelo_site_view_generation AFTER INSERT OR UPDATE OR DELETE ON %I
         DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
         EXECUTE FUNCTION caelo_bump_site_view_generation()', t);
    EXECUTE format(
      'CREATE TRIGGER caelo_site_view_generation_truncate AFTER TRUNCATE ON %I
         FOR EACH STATEMENT EXECUTE FUNCTION caelo_bump_site_view_generation()', t);
  END LOOP;
END
$do$;

COMMIT;
