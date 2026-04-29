-- SPDX-License-Identifier: MPL-2.0
--
-- Phase 9 — i18n foundation: locales registry + URL strategies +
-- per-page content_hash & translation_status + advanced URL routing
-- toggle + the §11.A propose/execute split for hard-to-revert ops.
--
-- Why a propose/execute split:
--   Adding/removing a locale, flipping the default, or changing a
--   URL strategy fans out across every page (URL changes, hreflang
--   rewrites, redirect rows). The AI can plan + queue the change,
--   but a human Owner clicks Approve to apply. See CLAUDE.md §11.A.

------------------------------------------------------------------------
-- locales — registry of every locale this site supports.
------------------------------------------------------------------------
CREATE TABLE locales (
  code           text PRIMARY KEY,           -- BCP-47, e.g. 'en', 'de', 'de-AT'
  display_name   text NOT NULL,              -- 'English', 'Deutsch'
  url_strategy   text NOT NULL DEFAULT 'subdirectory'
    CHECK (url_strategy IN ('none', 'subdirectory', 'subdomain', 'domain')),
  -- For 'subdomain': 'de.example.com'. For 'domain': 'example.de'.
  -- For 'none' / 'subdirectory': NULL.
  url_host       text NULL,
  is_default     boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Exactly one default locale at any time.
CREATE UNIQUE INDEX locales_one_default_idx ON locales (is_default)
  WHERE is_default = true;

ALTER TABLE locales ENABLE ROW LEVEL SECURITY;
ALTER TABLE locales FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS locales_authenticated_scope ON locales;
CREATE POLICY locales_authenticated_scope ON locales
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

-- Seed the default locale 'en' so a fresh install ships with one.
INSERT INTO locales (code, display_name, url_strategy, is_default)
VALUES ('en', 'English', 'none', true)
ON CONFLICT (code) DO NOTHING;

--> statement-breakpoint

------------------------------------------------------------------------
-- locale_pending_actions — AI proposals awaiting an Owner click.
-- §11.A: AI calls locales.propose_*; this row is written; an Owner
-- visits /security/locales/pending and clicks Approve which calls
-- locales.execute_proposal (human+system only).
------------------------------------------------------------------------
CREATE TABLE locale_pending_actions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_kind    text NOT NULL
    CHECK (action_kind IN (
      'create', 'delete', 'set_default', 'update_strategy'
    )),
  -- Full proposal payload: { code, display_name?, url_strategy?, url_host? }.
  payload        jsonb NOT NULL,
  -- Computed at propose-time: { affectedPageCount, redirectsToCreate, warnings: [] }.
  preview        jsonb NOT NULL DEFAULT '{}'::jsonb,
  proposed_by    uuid NOT NULL REFERENCES actors(id),
  proposed_at    timestamptz NOT NULL DEFAULT now(),
  status         text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'applied', 'rejected', 'superseded')),
  decided_by     uuid NULL REFERENCES actors(id),
  decided_at     timestamptz NULL,
  decision_note  text NULL
);

CREATE INDEX locale_pending_actions_pending_idx
  ON locale_pending_actions (proposed_at DESC) WHERE status = 'pending';

ALTER TABLE locale_pending_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE locale_pending_actions FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS locale_pending_actions_authenticated_scope ON locale_pending_actions;
CREATE POLICY locale_pending_actions_authenticated_scope ON locale_pending_actions
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

--> statement-breakpoint

------------------------------------------------------------------------
-- site_settings — singleton (id = 1). Holds the advanced_url_routing
-- toggle; default false hides subdomain/domain in the locale UI.
------------------------------------------------------------------------
CREATE TABLE site_settings (
  id                       int PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  advanced_url_routing     boolean NOT NULL DEFAULT false,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  updated_by               uuid NULL REFERENCES actors(id),
  CONSTRAINT site_settings_singleton CHECK (id = 1)
);

INSERT INTO site_settings (advanced_url_routing) VALUES (false);

ALTER TABLE site_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_settings FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS site_settings_authenticated_scope ON site_settings;
CREATE POLICY site_settings_authenticated_scope ON site_settings
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

--> statement-breakpoint

------------------------------------------------------------------------
-- pages content_hash + translation tracking.
-- content_hash = sha256 of canonical-JSON page+modules; recomputed in
-- the application layer (the chat-runner / preview composer) on
-- every write. We do NOT use a Postgres trigger because the canonical
-- JSON is an application-level concept (which fields to include, the
-- ordering, whether to include layout module IDs, etc.).
------------------------------------------------------------------------
ALTER TABLE pages
  ADD COLUMN content_hash         text NULL,
  ADD COLUMN content_changed_at   timestamptz NULL,
  -- The source page's content_hash that this translation was made from.
  -- NULL on the source page itself; populated on translation variants.
  ADD COLUMN translated_from_hash text NULL,
  -- Computed: 'source' (no translated_from_hash), 'fresh' (matches
  -- source content_hash), 'stale' (mismatch), 'untranslated' (no
  -- variant for this locale yet — virtual; never stored).
  ADD COLUMN translation_status   text NOT NULL DEFAULT 'source'
    CHECK (translation_status IN ('source', 'fresh', 'stale'));

CREATE INDEX pages_translation_status_idx
  ON pages (translation_status, locale)
  WHERE deleted_at IS NULL;

-- No site_snapshots.op_kind extension: locale config writes record
-- their full payload + decision in audit_events + locale_pending_actions
-- and don't fit the page/module entity tree the snapshot system reverts.
-- Lesson learned from the P7/P8 review passes (0025/0028 cleanup): only
-- add op_kinds when code actually emits a snapshot. Audit-only is
-- correct for hard-to-revert config changes.
