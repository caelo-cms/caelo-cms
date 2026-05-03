-- SPDX-License-Identifier: MPL-2.0
--
-- P16 — Multi-provider AI + cost dashboard + observability.
-- Lands all three P16 PRs' schema in one migration so the lower-level
-- changes (ai_calls.{operation_type, image_count, request_id}) and
-- higher-level tables (ai_pricing, ai_provider_configs, ai_budgets)
-- don't need to interleave with admin-app rebuilds.

------------------------------------------------------------------------
-- ai_provider_configs — operator-managed provider list. Single primary
-- enforced by partial unique. Owner UI at /security/ai/providers.
------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_provider_configs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('anthropic','openai','gemini','openai-compatible')),
  display_name    text NOT NULL,
  -- Plain string for openai/anthropic/gemini; secret-store ref path
  -- for cloud installs (e.g. "secret://caelo-anthropic-key").
  api_key_ref     text NOT NULL,
  model           text NOT NULL,
  -- Optional override for openai-compatible (e.g. http://localhost:11434/v1).
  base_url        text NULL,
  -- Image-capable providers declare which model to use for generate_image.
  image_model     text NULL,
  is_primary      boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_provider_configs_one_primary
  ON ai_provider_configs (is_primary) WHERE is_primary = true;
CREATE INDEX IF NOT EXISTS ai_provider_configs_kind_idx
  ON ai_provider_configs (kind);

ALTER TABLE ai_provider_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_provider_configs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_provider_configs_authed ON ai_provider_configs;
CREATE POLICY ai_provider_configs_authed ON ai_provider_configs
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (current_setting('caelo.actor_kind', true) = 'system');

------------------------------------------------------------------------
-- ai_pricing — per (provider, model, operation_type) cost in microcents.
-- Operator-editable so a provider rate change doesn't need a redeploy.
-- Historical rows kept (effective_from PK component) so old ai_calls
-- rows' cost calculations stay accurate.
------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_pricing (
  provider          text NOT NULL,
  model             text NOT NULL,
  operation_type    text NOT NULL CHECK (operation_type IN ('text','image')),
  -- Microcents per 1K input tokens (text) OR per image (image).
  input_microcents  bigint NOT NULL,
  -- Microcents per 1K output tokens. NULL for image (single-cost shape).
  output_microcents bigint NULL,
  -- Microcents per 1K cached tokens (Anthropic prompt-cache reads).
  cached_microcents bigint NULL,
  effective_from    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, model, operation_type, effective_from)
);
CREATE INDEX IF NOT EXISTS ai_pricing_lookup_idx
  ON ai_pricing (provider, model, operation_type, effective_from DESC);

ALTER TABLE ai_pricing ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_pricing FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_pricing_authed ON ai_pricing;
CREATE POLICY ai_pricing_authed ON ai_pricing
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (current_setting('caelo.actor_kind', true) = 'system');

-- Seed: prices in microcents (×1e-8 USD). Per-1K-tokens for text;
-- per-image for image. All values illustrative — operator edits via
-- /security/ai/pricing as providers update their rates.
-- Provider names MUST match the canonical ai_providers.name enum
-- (`anthropic` | `openai` | `google` | `local-openai-compat`) — recordAiCall
-- looks up pricing by the same string the chat-runner persists into
-- ai_calls.provider, which comes from ai_providers.name. Mis-naming
-- here would make Gemini + local provider calls silently price at $0.
INSERT INTO ai_pricing (provider, model, operation_type, input_microcents, output_microcents, cached_microcents)
VALUES
  ('anthropic',           'claude-opus-4-7',                'text',  1500000, 7500000, 150000),
  ('openai',              'gpt-4o',                         'text',   250000, 1000000, 125000),
  ('openai',              'dall-e-3',                       'image', 4000000,    NULL,   NULL),
  ('google',              'gemini-1.5-pro',                 'text',   350000, 1050000,  87500),
  ('google',              'imagen-3.0-generate-001',        'image', 4000000,    NULL,   NULL),
  ('local-openai-compat', '*',                              'text',        0,       0,      0)
ON CONFLICT DO NOTHING;

------------------------------------------------------------------------
-- ai_budgets — operation-type-aware caps per scope. Text and image
-- enforce independently (image cap exhausted ≠ text blocked).
------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_budgets (
  scope          text NOT NULL CHECK (scope IN ('session','day-global','day-per-actor')),
  operation_type text NOT NULL CHECK (operation_type IN ('text','image')),
  cap_microcents bigint NULL,
  warn_at_pct    numeric(3,2) NOT NULL DEFAULT 0.80 CHECK (warn_at_pct >= 0 AND warn_at_pct <= 1),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, operation_type)
);

ALTER TABLE ai_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_budgets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_budgets_authed ON ai_budgets;
CREATE POLICY ai_budgets_authed ON ai_budgets
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (current_setting('caelo.actor_kind', true) = 'system');

------------------------------------------------------------------------
-- ai_calls extension — operation_type + image_count + request_id.
-- Default operation_type='text' so existing rows backfill cleanly.
-- request_id correlates with structured-log entries + audit_events.
------------------------------------------------------------------------
ALTER TABLE ai_calls
  ADD COLUMN IF NOT EXISTS operation_type text NOT NULL DEFAULT 'text'
    CHECK (operation_type IN ('text','image')),
  ADD COLUMN IF NOT EXISTS image_count int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS request_id text NULL;

CREATE INDEX IF NOT EXISTS ai_calls_op_type_idx
  ON ai_calls (operation_type, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_calls_request_id_idx
  ON ai_calls (request_id) WHERE request_id IS NOT NULL;

------------------------------------------------------------------------
-- audit_events extension — request_id + AI provenance fields.
-- Single greppable correlation key (request_id) joins logs ↔ audit ↔ ai_calls.
------------------------------------------------------------------------
ALTER TABLE audit_events
  ADD COLUMN IF NOT EXISTS request_id text NULL,
  ADD COLUMN IF NOT EXISTS provider text NULL,
  ADD COLUMN IF NOT EXISTS model text NULL,
  ADD COLUMN IF NOT EXISTS operation_type text NULL CHECK (operation_type IN ('text','image'));

CREATE INDEX IF NOT EXISTS audit_events_request_id_idx
  ON audit_events (request_id) WHERE request_id IS NOT NULL;

------------------------------------------------------------------------
-- telemetry_settings — singleton; off-by-default; opt-in toggles.
-- Owner UI at /security/telemetry. Test-send prints payload locally
-- without an outbound HTTP call.
------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS telemetry_settings (
  id                       int PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  install_ping_enabled     boolean NOT NULL DEFAULT false,
  error_reporting_enabled  boolean NOT NULL DEFAULT false,
  -- Anonymized install id minted on first opt-in; never sent before.
  install_id               uuid NULL,
  events_sent_count        bigint NOT NULL DEFAULT 0,
  last_sent_at             timestamptz NULL,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT telemetry_settings_singleton CHECK (id = 1)
);

-- Seed the singleton row. GENERATED ALWAYS column needs explicit
-- `OVERRIDING SYSTEM VALUE` to allow the explicit `id = 1`.
INSERT INTO telemetry_settings (id)
OVERRIDING SYSTEM VALUE VALUES (1)
ON CONFLICT DO NOTHING;

ALTER TABLE telemetry_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE telemetry_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS telemetry_settings_authed ON telemetry_settings;
CREATE POLICY telemetry_settings_authed ON telemetry_settings
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (current_setting('caelo.actor_kind', true) = 'system');
