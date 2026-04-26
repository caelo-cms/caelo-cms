-- SPDX-License-Identifier: MPL-2.0
--
-- Phase 3: content primitives — modules, templates, template_blocks, pages,
-- page_modules. Hand-written so the SQL surface stays auditable (CLAUDE.md §2);
-- the drizzle schema files under src/schema/cms_admin/ mirror these for
-- downstream type inference.
--
-- Live-reference invariant: pages reference modules through page_modules only.
-- The pages table has no `html` column — the §3.1 "no raw HTML on pages"
-- invariant is enforced at the column level here, not just by the Validator.
--
-- (slug, locale) is the public identity of a page; locale defaults to 'en' and
-- the full multi-locale config (URL strategy, translation status, hreflang)
-- arrives in P9. SEO fields land in P8 in their own table.

------------------------------------------------------------------------
-- modules — reusable HTML/CSS/JS blocks
------------------------------------------------------------------------
CREATE TABLE modules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  html          text NOT NULL,
  css           text NOT NULL DEFAULT '',
  js            text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz NULL
);

CREATE INDEX modules_deleted_at_idx
  ON modules (deleted_at) WHERE deleted_at IS NOT NULL;

--> statement-breakpoint

------------------------------------------------------------------------
-- templates — layout shells with <caelo-slot name="…"> markers
------------------------------------------------------------------------
CREATE TABLE templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  html          text NOT NULL,
  css           text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz NULL
);

CREATE INDEX templates_deleted_at_idx
  ON templates (deleted_at) WHERE deleted_at IS NOT NULL;

--> statement-breakpoint

------------------------------------------------------------------------
-- template_blocks — slot inventory per template
------------------------------------------------------------------------
CREATE TABLE template_blocks (
  template_id   uuid NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  name          text NOT NULL,
  display_name  text NOT NULL,
  position      integer NOT NULL,
  PRIMARY KEY (template_id, name)
);

--> statement-breakpoint

------------------------------------------------------------------------
-- pages — composed pages, no raw HTML column
------------------------------------------------------------------------
CREATE TABLE pages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL,
  locale        text NOT NULL DEFAULT 'en',
  title         text NOT NULL,
  template_id   uuid NOT NULL REFERENCES templates(id),
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz NULL,
  CONSTRAINT pages_slug_locale_unique UNIQUE (slug, locale)
);

CREATE INDEX pages_template_id_idx ON pages (template_id);
CREATE INDEX pages_deleted_at_idx
  ON pages (deleted_at) WHERE deleted_at IS NOT NULL;

--> statement-breakpoint

------------------------------------------------------------------------
-- page_modules — ordered modules per (page, block)
------------------------------------------------------------------------
CREATE TABLE page_modules (
  page_id       uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  block_name    text NOT NULL,
  position      integer NOT NULL,
  module_id     uuid NOT NULL REFERENCES modules(id),
  PRIMARY KEY (page_id, block_name, position)
);

CREATE INDEX page_modules_module_id_idx ON page_modules (module_id);

--> statement-breakpoint

------------------------------------------------------------------------
-- RLS for the new tables. Site-wide content — every authenticated Query API
-- caller (human / ai / system) reads + writes; anonymous DB connections that
-- never called set_config('caelo.actor_kind', ...) match no rows. Per-actor
-- scoping returns at P11 for plugin tables.
--
-- Inline here (not appended to 9999_rls_policies.sql) because the migration
-- runner is keyed by basename and never re-runs an already-applied file —
-- same pattern P2.2 used for rate_limit_buckets.
------------------------------------------------------------------------

ALTER TABLE modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE modules FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS modules_authenticated_scope ON modules;
CREATE POLICY modules_authenticated_scope ON modules
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

ALTER TABLE templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE templates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS templates_authenticated_scope ON templates;
CREATE POLICY templates_authenticated_scope ON templates
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

ALTER TABLE template_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE template_blocks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS template_blocks_authenticated_scope ON template_blocks;
CREATE POLICY template_blocks_authenticated_scope ON template_blocks
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

ALTER TABLE pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE pages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pages_authenticated_scope ON pages;
CREATE POLICY pages_authenticated_scope ON pages
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

ALTER TABLE page_modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE page_modules FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS page_modules_authenticated_scope ON page_modules;
CREATE POLICY page_modules_authenticated_scope ON page_modules
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);
