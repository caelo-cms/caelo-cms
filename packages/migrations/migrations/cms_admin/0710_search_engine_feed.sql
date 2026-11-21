-- SPDX-License-Identifier: MPL-2.0
--
-- 0710 — an Atom feed of the latest changes, WebSub and IndexNow pings after
-- every Publish live, and a real "last changed" date per page
-- (docs/dev/search-engine-feed.md).
--
-- Before this, a sitemap's <lastmod> was `pages.updated_at`: the time of the
-- last draft edit of the page row, which a text edit inside a module never
-- moves, and which is not when the change went live. Search engines use a
-- date only while it keeps matching what they find, so the date has to come
-- from what was published:
--
--   live_page_versions — append-only: one row each time a page's live
--     content (a fingerprint of what the page itself shows, header and
--     footer excluded) or its live URL changed, written only by what changes
--     production (Publish live, an Owner's production build, a rollback) in
--     the transaction that records the run. The newest row per page is what
--     is live. `changed_at` is the date the feed and the sitemap show.
--     The plugin-data build (#1155) appends a `changed` row too, when what
--     a plugin bakes into a page (approved comments) changed live.
--     `baseline` rows record what was already live when this shipped (the
--     first Publish live after the update); they are not announced to
--     search engines. A rollback appends `restored` rows: the restored
--     build's state per page, read back from this log.
--
--   staged_page_changes — what a Stage found changed against the live log
--     (`deploy_runs.live_versions_base`), kept for the two newest Stages of
--     the staging target so Publish live can record exactly what it ships.
--
--   search_engine_notifications — one WebSub ping and one IndexNow
--     submission per production run, sent right after the run is recorded,
--     inside the request that published (CLAUDE.md §11.B Tier 5), retried by
--     the scheduler tick.
--
-- site_defaults gains the two switches (both on: the sitemap is on by
-- default too) and the site's IndexNow key, a public value by design: every
-- build serves it at /<key>.txt so the engines can verify the site.
--
-- Expand-safe: new tables, new columns with defaults; the previous release
-- reads none of them.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE site_defaults
  ADD COLUMN IF NOT EXISTS feed_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS indexnow_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS indexnow_key text NOT NULL
    DEFAULT replace(gen_random_uuid()::text, '-', '')
    CHECK (indexnow_key ~ '^[A-Za-z0-9-]{8,128}$');

COMMENT ON COLUMN site_defaults.feed_enabled IS
  'Write /feed.xml (Atom, the latest changed pages) with every build, link it from every page and robots.txt, and ping the WebSub hub after Publish live.';
COMMENT ON COLUMN site_defaults.indexnow_enabled IS
  'Serve /<indexnow_key>.txt and submit the URLs a Publish live changed to IndexNow.';
COMMENT ON COLUMN site_defaults.indexnow_key IS
  'The site''s IndexNow key. Public by design: the key file proves the site to the engines.';

-- What a build recorded about its feed and its page changes.
ALTER TABLE deploy_runs
  -- Staging and production builds: the live_page_versions head the build
  -- compared its pages against (NULL: the log was empty).
  ADD COLUMN IF NOT EXISTS live_versions_base bigint NULL,
  -- Production runs: the log head right after this run recorded what it
  -- made live — the state a rollback to this run restores.
  ADD COLUMN IF NOT EXISTS live_versions_head bigint NULL,
  -- The absolute URL of the feed the build serves; NULL: none.
  ADD COLUMN IF NOT EXISTS feed_url text NULL CHECK (feed_url IS NULL OR char_length(feed_url) <= 2048),
  -- The IndexNow key the build serves at /<key>.txt; NULL: none.
  ADD COLUMN IF NOT EXISTS indexnow_key text NULL CHECK (indexnow_key IS NULL OR indexnow_key ~ '^[A-Za-z0-9-]{8,128}$'),
  -- A Stage recorded what its build changes (staged_page_changes). False
  -- for every run from before this migration: its Publish live has no
  -- changes to record, and must not read the missing rows as "every page
  -- removed".
  ADD COLUMN IF NOT EXISTS page_changes_recorded boolean NOT NULL DEFAULT false,
  -- A Publish live: the Stage it ships. While it runs, that Stage keeps its
  -- staged_page_changes even when newer Stages finish.
  ADD COLUMN IF NOT EXISTS promoted_from_run_id uuid NULL REFERENCES deploy_runs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS deploy_runs_promoted_from_idx ON deploy_runs (promoted_from_run_id);

CREATE TABLE IF NOT EXISTS live_page_versions (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- The production run that made this state live. Runs are never deleted
  -- (nothing collects deploy_runs); the cascade only keeps test resets simple.
  run_id       uuid NOT NULL REFERENCES deploy_runs(id) ON DELETE CASCADE,
  -- No foreign key: the history of a page outlives its row.
  page_id      uuid NOT NULL,
  -- `redated`: the same content, now served with another date (a rollback
  -- or a Publish live put back files that show it); never announced.
  kind         text NOT NULL CHECK (kind IN ('baseline', 'added', 'changed', 'moved', 'removed', 'restored', 'redated')),
  -- The public URL the page is live at; NULL once it is no longer live.
  url          text NULL CHECK (url IS NULL OR char_length(url) <= 2048),
  fingerprint  text NULL CHECK (fingerprint IS NULL OR fingerprint ~ '^[0-9a-f]{64}$'),
  -- What the plugins baked into the page shows (comments, say): NULL when
  -- no plugin bakes into it. A change of either fingerprint is a change.
  plugin_fingerprint text NULL CHECK (plugin_fingerprint IS NULL OR plugin_fingerprint ~ '^[0-9a-f]{64}$'),
  -- The title and meta description the page was published with: what its
  -- feed entry shows, from what was published, never from a page row that
  -- may hold unpublished edits. NULL once it is no longer live.
  title        text NULL CHECK (title IS NULL OR char_length(title) <= 1000),
  summary      text NULL CHECK (summary IS NULL OR char_length(summary) <= 2000),
  -- The URL it was live at before this row; NULL when it was not live.
  prev_url     text NULL CHECK (prev_url IS NULL OR char_length(prev_url) <= 2048),
  -- When its live content last changed: the date the feed and the sitemap show.
  changed_at   timestamptz NOT NULL,
  recorded_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((url IS NULL) = (fingerprint IS NULL)),
  CHECK (url IS NOT NULL OR plugin_fingerprint IS NULL),
  CHECK ((url IS NULL) = (title IS NULL) AND (url IS NULL) = (summary IS NULL)),
  CHECK ((kind = 'removed') = (url IS NULL))
);
-- The newest row per page (the live state), for a page and for every page.
CREATE INDEX IF NOT EXISTS live_page_versions_page_idx ON live_page_versions (page_id, id DESC);
-- The rows one run appended (its IndexNow URLs); also the FK's index.
CREATE INDEX IF NOT EXISTS live_page_versions_run_idx ON live_page_versions (run_id);

CREATE TABLE IF NOT EXISTS staged_page_changes (
  target_id    uuid NOT NULL REFERENCES deploy_targets(id) ON DELETE CASCADE,
  run_id       uuid NOT NULL REFERENCES deploy_runs(id) ON DELETE CASCADE,
  page_id      uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('baseline', 'added', 'changed', 'moved', 'removed')),
  url          text NULL CHECK (url IS NULL OR char_length(url) <= 2048),
  fingerprint  text NULL CHECK (fingerprint IS NULL OR fingerprint ~ '^[0-9a-f]{64}$'),
  -- What the plugins baked into the page shows (comments, say): NULL when
  -- no plugin bakes into it. A change of either fingerprint is a change.
  plugin_fingerprint text NULL CHECK (plugin_fingerprint IS NULL OR plugin_fingerprint ~ '^[0-9a-f]{64}$'),
  -- The title and meta description the page was published with: what its
  -- feed entry shows, from what was published, never from a page row that
  -- may hold unpublished edits. NULL once it is no longer live.
  title        text NULL CHECK (title IS NULL OR char_length(title) <= 1000),
  summary      text NULL CHECK (summary IS NULL OR char_length(summary) <= 2000),
  prev_url     text NULL CHECK (prev_url IS NULL OR char_length(prev_url) <= 2048),
  changed_at   timestamptz NOT NULL,
  PRIMARY KEY (run_id, page_id),
  CHECK ((url IS NULL) = (fingerprint IS NULL)),
  CHECK (url IS NOT NULL OR plugin_fingerprint IS NULL),
  CHECK ((url IS NULL) = (title IS NULL) AND (url IS NULL) = (summary IS NULL)),
  CHECK ((kind = 'removed') = (url IS NULL))
);
CREATE INDEX IF NOT EXISTS staged_page_changes_target_idx ON staged_page_changes (target_id, run_id);

CREATE TABLE IF NOT EXISTS search_engine_notifications (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id           uuid NOT NULL REFERENCES deploy_runs(id) ON DELETE CASCADE,
  channel          text NOT NULL CHECK (channel IN ('websub', 'indexnow')),
  status           text NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  -- WebSub: 1 (the feed); IndexNow: the URLs submitted.
  url_count        integer NOT NULL CHECK (url_count >= 0),
  attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- When a pending row is due (again). A claim moves it ahead, so two ticks
  -- never send the same row at once.
  next_attempt_at  timestamptz NULL,
  -- What the engine answered last (HTTP status), and why it failed or was skipped.
  response_status  integer NULL,
  detail           text NULL CHECK (detail IS NULL OR char_length(detail) <= 2000),
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at      timestamptz NULL,
  UNIQUE (run_id, channel),
  CHECK ((status = 'pending') = (next_attempt_at IS NOT NULL)),
  CHECK ((status IN ('pending')) = (finished_at IS NULL))
);
CREATE INDEX IF NOT EXISTS search_engine_notifications_due_idx
  ON search_engine_notifications (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS search_engine_notifications_recent_idx
  ON search_engine_notifications (created_at DESC);

ALTER TABLE live_page_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE live_page_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS live_page_versions_authenticated_scope ON live_page_versions;
CREATE POLICY live_page_versions_authenticated_scope ON live_page_versions
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

ALTER TABLE staged_page_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE staged_page_changes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS staged_page_changes_authenticated_scope ON staged_page_changes;
CREATE POLICY staged_page_changes_authenticated_scope ON staged_page_changes
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

ALTER TABLE search_engine_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_engine_notifications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS search_engine_notifications_authenticated_scope ON search_engine_notifications;
CREATE POLICY search_engine_notifications_authenticated_scope ON search_engine_notifications
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

COMMIT;
