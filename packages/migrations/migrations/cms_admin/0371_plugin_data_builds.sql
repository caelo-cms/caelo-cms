-- SPDX-License-Identifier: MPL-2.0
--
-- 0371 — issue #1155: plugin data reaches the static HTML without
-- publishing anything else.
--
-- An approved comment (or any item a plugin bakes into pages) is served at
-- once through the Web Component's delta fetch (CMS_REQUIREMENTS §6.1). A
-- plugin-data build then re-renders that plugin's bake regions in the files
-- of the build that is LIVE and publishes the result, so the HTML carries
-- the item and the delta feed's `since` moves past it. Every byte outside
-- those regions is the published build's, so no draft, staged or main-only
-- change goes live (admin-core plugin-data/build.ts).
--
--   plugin_data_stale_pages
--     which (plugin, page) bakes are stale. A declared baked-data trigger
--     (plugin SDK `bakedData`) marks a row: the admin's own operation call,
--     or a visitor op event the admin validated as a hint. A row is pending
--     while `last_marked_at > baked_through` (or nothing baked it yet);
--     a plugin-data build sets `baked_through` to the instant it read the
--     plugin's data. Publish live of an older Stage lowers it again to that
--     Stage's start (deploy.promote), because the promoted HTML carries the
--     data of then.
--
--   plugin_data_build_state
--     the tick's bookkeeping: the watermark in cms_public
--     gateway_plugin_op_events (visitor hints) and the last outcome, so a
--     tick that cannot build (say the live build predates bake markers)
--     says why instead of failing silently.
--
--   deploy_runs.build_kind / base_run_id / plugin_data
--     a plugin-data build is a deploy run of its own kind, recorded and
--     audited apart from a Publish live; `base_run_id` is the published run
--     its files came from, `plugin_data` what it re-baked.
--
-- Not a contract migration: the columns are additive with a default, and
-- the previous image reads neither table.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE deploy_runs
  ADD COLUMN build_kind text NOT NULL DEFAULT 'site'
    CHECK (build_kind IN ('site', 'plugin_data')),
  ADD COLUMN base_run_id uuid NULL REFERENCES deploy_runs(id) ON DELETE SET NULL,
  ADD COLUMN plugin_data jsonb NULL;

CREATE TABLE plugin_data_stale_pages (
  plugin_id       uuid NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  page_id         uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  first_marked_at timestamptz NOT NULL DEFAULT now(),
  last_marked_at  timestamptz NOT NULL DEFAULT now(),
  -- The instant the last plugin-data build read the plugin's data for this
  -- page (its bakes carry data-baked-at = this); NULL: never baked by one.
  baked_through   timestamptz NULL,
  last_run_id     uuid NULL REFERENCES deploy_runs(id) ON DELETE SET NULL,
  last_source     text NOT NULL CHECK (last_source IN ('operation', 'visitor')),
  PRIMARY KEY (plugin_id, page_id)
);
CREATE INDEX plugin_data_stale_pages_pending_idx ON plugin_data_stale_pages (last_marked_at)
  WHERE baked_through IS NULL OR last_marked_at > baked_through;

CREATE TABLE plugin_data_build_state (
  id                       smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  visitor_event_watermark  bigint NOT NULL DEFAULT 0 CHECK (visitor_event_watermark >= 0),
  last_tick_at             timestamptz NULL,
  last_outcome             text NULL
    CHECK (last_outcome IS NULL OR last_outcome IN
      ('nothing_pending', 'unchanged', 'built', 'blocked', 'failed')),
  last_message             text NULL CHECK (last_message IS NULL OR char_length(last_message) <= 4000)
);
INSERT INTO plugin_data_build_state DEFAULT VALUES;

ALTER TABLE plugin_data_stale_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE plugin_data_stale_pages FORCE ROW LEVEL SECURITY;
CREATE POLICY plugin_data_stale_pages_read ON plugin_data_stale_pages FOR SELECT
  USING (current_setting('caelo.actor_kind', true) IN ('human', 'ai', 'system'));
-- `human` too: a human's Publish live and rollback make bakes pending
-- again inside their own transaction (plugin-data/stale-pages.ts). Marks
-- and bakes themselves are written by the system actor only.
CREATE POLICY plugin_data_stale_pages_write ON plugin_data_stale_pages
  USING (current_setting('caelo.actor_kind', true) IN ('human', 'system'))
  WITH CHECK (current_setting('caelo.actor_kind', true) IN ('human', 'system'));

ALTER TABLE plugin_data_build_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE plugin_data_build_state FORCE ROW LEVEL SECURITY;
CREATE POLICY plugin_data_build_state_read ON plugin_data_build_state FOR SELECT
  USING (current_setting('caelo.actor_kind', true) IN ('human', 'ai', 'system'));
CREATE POLICY plugin_data_build_state_write ON plugin_data_build_state
  USING (current_setting('caelo.actor_kind', true) = 'system')
  WITH CHECK (current_setting('caelo.actor_kind', true) = 'system');

COMMIT;
