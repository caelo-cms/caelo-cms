-- SPDX-License-Identifier: MPL-2.0
--
-- P13 — static-render cache for plugin-emitted HTML.
--
-- Each (plugin, page, locale) tuple records the last bake's HTML +
-- cache key + timestamp. The static generator's plugin pass consults
-- this table to skip re-renders when the cache key matches; misses
-- recompute and overwrite the row.

CREATE TABLE IF NOT EXISTS static_bakes (
  plugin_id     uuid NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  page_id       uuid NOT NULL REFERENCES pages(id)  ON DELETE CASCADE,
  locale        text NOT NULL REFERENCES locales(code),
  baked_at      timestamptz NOT NULL DEFAULT now(),
  cache_key     text NOT NULL,
  rendered_html text NOT NULL,
  PRIMARY KEY (plugin_id, page_id, locale)
);

CREATE INDEX IF NOT EXISTS static_bakes_baked_idx ON static_bakes (baked_at DESC);

ALTER TABLE static_bakes ENABLE ROW LEVEL SECURITY;
ALTER TABLE static_bakes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS static_bakes_authenticated_scope ON static_bakes;
CREATE POLICY static_bakes_authenticated_scope ON static_bakes
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);
