-- SPDX-License-Identifier: MPL-2.0
--
-- Phase 6.7.5 — pages lifecycle + structured-data sets + redirects.
--
-- Five additions:
--
--   1. `pages.name`        — internal editor label, distinct from
--                            `title` (the public <title> tag) and
--                            `slug` (the URL path component). The
--                            page picker / breadcrumbs / chat-history
--                            dropdown read `name`; only the deployed
--                            site reads `title`. Existing rows
--                            backfill `name = title` so nothing breaks.
--   2. `redirects`         — minimal 301 store. `change_page_slug` and
--                            `delete_page disposition='redirect'` write
--                            here; the static generator emits
--                            `_redirects.caddy`; SvelteKit hooks fall
--                            back to it on a 404 for the smoke server.
--   3. `structured_sets`   — generic named-list primitive. One table
--                            for every kind of typed structured data
--                            the editor + AI can manipulate: nav-menu,
--                            taxonomy, theme, tags, link-list. Items
--                            are jsonb arrays Zod-validated per kind.
--   4. `site_ai_memory`    — extend the slot CHECK with `purpose` so
--                            the AI sees what the site is FOR before
--                            its voice/tone slots.
--   5. RLS on the new tables: FORCE, with a `caelo.actor_kind`-non-null
--                            policy matching the P3 content-table
--                            pattern. The Owner-only theme writes are
--                            gated at the route layer (locale-strategy
--                            pattern), not in RLS.

------------------------------------------------------------------------
-- pages.name (nullable; rowToPage falls back to title at read time so
-- legacy INSERTs that don't supply a name keep working).
------------------------------------------------------------------------
ALTER TABLE pages ADD COLUMN name text;
UPDATE pages SET name = title WHERE name IS NULL;

------------------------------------------------------------------------
-- redirects
------------------------------------------------------------------------
CREATE TABLE redirects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_path   text NOT NULL UNIQUE,
  to_path     text NOT NULL,
  status_code int  NOT NULL DEFAULT 301 CHECK (status_code IN (301, 302, 307, 308, 410)),
  created_by  uuid NOT NULL REFERENCES actors(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT redirects_from_path_starts_with_slash CHECK (from_path LIKE '/%'),
  CONSTRAINT redirects_no_self_loop CHECK (from_path <> to_path)
);

ALTER TABLE redirects ENABLE ROW LEVEL SECURITY;
ALTER TABLE redirects FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS redirects_authenticated_scope ON redirects;
CREATE POLICY redirects_authenticated_scope ON redirects
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

------------------------------------------------------------------------
-- structured_sets
------------------------------------------------------------------------
CREATE TABLE structured_sets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 'nav-menu' | 'taxonomy' | 'theme' | 'tags' | 'link-list' | future kinds.
  -- Validated at the Query API layer per-kind; left as text here so a
  -- new kind doesn't require a migration.
  kind         text NOT NULL,
  slug         text NOT NULL,
  display_name text NOT NULL,
  items        jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid REFERENCES actors(id),
  UNIQUE (kind, slug)
);

CREATE INDEX structured_sets_kind_idx ON structured_sets (kind);

ALTER TABLE structured_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE structured_sets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS structured_sets_authenticated_scope ON structured_sets;
CREATE POLICY structured_sets_authenticated_scope ON structured_sets
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

------------------------------------------------------------------------
-- site_ai_memory: add 'purpose' slot
------------------------------------------------------------------------
ALTER TABLE site_ai_memory DROP CONSTRAINT site_ai_memory_slot_check;
ALTER TABLE site_ai_memory
  ADD CONSTRAINT site_ai_memory_slot_check
  CHECK (slot IN ('purpose','brand-voice','tone','banned-phrases','instructions','glossary'));

ALTER TABLE site_memory_proposals DROP CONSTRAINT site_memory_proposals_slot_check;
ALTER TABLE site_memory_proposals
  ADD CONSTRAINT site_memory_proposals_slot_check
  CHECK (slot IN ('purpose','brand-voice','tone','banned-phrases','instructions','glossary'));
