-- SPDX-License-Identifier: MPL-2.0
--
-- Phase 11 — Two-tier plugin host.
--
-- Caelo is a plugin host. Almost every feature beyond the kernel is a
-- plugin. The runtime decides which capabilities are exposed:
--
--   Tier 1 (core)  — `packages/plugins/<slug>/`, audited, signed, runs
--                    in-process in Bun, full SDK (cross-cms_admin
--                    writes, snapshot emission, chat-runner tool
--                    registration, AI provider, background workers).
--                    Auto-activated at host startup after manifest
--                    signature verifies.
--
--   Tier 2 (user)  — AI-authored at runtime, source in
--                    `plugins.source_code`, runs in a Deno subprocess
--                    with --no-read --no-write --no-net flags. Locked
--                    SDK (only its own cms_public.<slug> schema).
--                    Owner click required for activation.
--
-- The SDK exports the same shapes for both tiers; the runtime masks
-- capabilities. A Tier 2 manifest declaring `tier: 1` or
-- `requestedCapabilities` is rejected by the validator.

------------------------------------------------------------------------
-- plugins — registry of every loaded or submitted plugin, both tiers.
------------------------------------------------------------------------
CREATE TABLE plugins (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug               text NOT NULL UNIQUE,
  version            text NOT NULL,
  /* Tier — drives runtime + capability mask. Set at registration; immutable. */
  tier               int  NOT NULL CHECK (tier IN (1, 2)),
  status             text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','validated','awaiting_activation','active','disabled','failed')),
  /* The full manifest as written by the plugin author. Schema, operations,
   * component, staticRender, requestedCapabilities (Tier 1 only). */
  manifest_json      jsonb NOT NULL,
  /* Tier 2: full source as submitted, preserved verbatim so revalidation
   * on a Caelo upgrade catches new forbidden patterns. Tier 1: NULL —
   * source lives in packages/plugins/<slug>/. */
  source_code        text NULL,
  /* Tier 1: filesystem path discovered at startup (e.g. "packages/plugins/translation"). */
  source_path        text NULL,
  /* Validator output. Empty array when status >= 'validated'. */
  validation_errors  jsonb NOT NULL DEFAULT '[]'::jsonb,
  /* Tier 1: Ed25519 signature over the manifest, verified at host startup
   * against the embedded Caelo public key. Tier 2: NULL. */
  manifest_signature text NULL,
  /* Provenance. Tier 2: AI / human submitter. Tier 1: system actor (the host loader). */
  submitted_by       uuid NOT NULL REFERENCES actors(id),
  activated_by       uuid NULL REFERENCES actors(id),
  activated_at       timestamptz NULL,
  disabled_by        uuid NULL REFERENCES actors(id),
  disabled_at        timestamptz NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  /* Tier 1 must carry a manifest signature; Tier 2 must not. */
  CONSTRAINT plugins_tier1_signed
    CHECK (tier = 2 OR manifest_signature IS NOT NULL),
  /* Tier 1 source lives on disk, not in the DB. */
  CONSTRAINT plugins_tier1_no_source_in_db
    CHECK (tier = 2 OR source_code IS NULL),
  /* Tier 2 source MUST be in the DB. */
  CONSTRAINT plugins_tier2_has_source
    CHECK (tier = 1 OR source_code IS NOT NULL),
  /* Tier 2 plugins do not declare a filesystem source path. */
  CONSTRAINT plugins_tier2_no_source_path
    CHECK (tier = 1 OR source_path IS NULL)
);
CREATE INDEX plugins_status_idx ON plugins (status, slug);
CREATE INDEX plugins_tier_idx   ON plugins (tier, status);

ALTER TABLE plugins ENABLE ROW LEVEL SECURITY;
ALTER TABLE plugins FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS plugins_authenticated_scope ON plugins;
CREATE POLICY plugins_authenticated_scope ON plugins
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

--> statement-breakpoint

------------------------------------------------------------------------
-- plugin_schema_migrations — applied SQL per plugin version.
-- The validator emits CREATE TABLE statements from the plugin's
-- declared `schema` field; activation runs them inside a single
-- transaction and records what was applied. If activation fails the
-- transaction rolls back; the plugin status stays at awaiting_activation.
------------------------------------------------------------------------
CREATE TABLE plugin_schema_migrations (
  plugin_id    uuid NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  /* Version this migration set was applied for. Multiple rows allowed
   * across plugin upgrades; the latest row reflects the current schema. */
  applied_for_version text NOT NULL,
  applied_sql  text NOT NULL,
  applied_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (plugin_id, applied_at)
);

ALTER TABLE plugin_schema_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE plugin_schema_migrations FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS plugin_schema_migrations_authenticated_scope ON plugin_schema_migrations;
CREATE POLICY plugin_schema_migrations_authenticated_scope ON plugin_schema_migrations
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

--> statement-breakpoint

------------------------------------------------------------------------
-- actors.plugin_id — when a plugin operation runs (Tier 1 or Tier 2),
-- the Database Adapter sets caelo.plugin_id so cms_public RLS scopes
-- writes to the plugin's own schema.
------------------------------------------------------------------------
ALTER TABLE actors
  ADD COLUMN IF NOT EXISTS plugin_id uuid NULL REFERENCES plugins(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS actors_plugin_idx
  ON actors (plugin_id) WHERE plugin_id IS NOT NULL;
