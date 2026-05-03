-- SPDX-License-Identifier: MPL-2.0
--
-- P13 — gateway hardening surface.
--   1. Extend `rate_limit_buckets` with token-bucket overlay columns
--      (so the same row tracks both the sliding window and the burst
--      tokens — one round-trip per request).
--   2. New `gateway_request_log` for /security/gateway dashboard +
--      adversarial debugging. 30-day TTL via the redeploy-orchestrator
--      cron (P13 PR2). Extra-cheap append-only writes.
--   3. New `pow_challenges` for Proof-of-Work captcha replay defence.
--      Issued challenges TTL 60s; solved challenges marked `used`.
--   4. Extend `site_settings` with gateway-specific config:
--      `gateway_cookie_secret` (HMAC), `auto_redeploy_enabled` (bool),
--      `auto_redeploy_debounce_ms` (int), `captcha_provider`
--      (enum: pow / turnstile / hcaptcha / off), per-provider config.

------------------------------------------------------------------------
-- 1. rate_limit_buckets extension — burst tokens.
------------------------------------------------------------------------
ALTER TABLE rate_limit_buckets
  ADD COLUMN IF NOT EXISTS tokens_remaining integer NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS last_refill_at  timestamptz NOT NULL DEFAULT now();

------------------------------------------------------------------------
-- 2. gateway_request_log — append-only, dashboard surface.
------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gateway_request_log (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_slug         text NOT NULL,
  operation           text NOT NULL,
  visitor_id_hash     text NOT NULL,
  status_code         int  NOT NULL,
  duration_ms         int  NOT NULL,
  body_bytes          int  NOT NULL DEFAULT 0,
  was_rate_limited    bool NOT NULL DEFAULT false,
  was_honeypot_caught bool NOT NULL DEFAULT false,
  captcha_passed      bool NOT NULL DEFAULT false,
  error_kind          text NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gateway_request_log_created_idx
  ON gateway_request_log (created_at DESC);
CREATE INDEX IF NOT EXISTS gateway_request_log_plugin_idx
  ON gateway_request_log (plugin_slug, operation, created_at DESC);
CREATE INDEX IF NOT EXISTS gateway_request_log_throttled_idx
  ON gateway_request_log (created_at DESC) WHERE was_rate_limited;

ALTER TABLE gateway_request_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE gateway_request_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gateway_request_log_authenticated_scope ON gateway_request_log;
CREATE POLICY gateway_request_log_authenticated_scope ON gateway_request_log
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

------------------------------------------------------------------------
-- 3. pow_challenges — issued + used challenges for replay defence.
------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pow_challenges (
  challenge   text PRIMARY KEY,
  target_hex  text NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz NULL,
  visitor_id_hash text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pow_challenges_expires_idx
  ON pow_challenges (expires_at);

ALTER TABLE pow_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE pow_challenges FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pow_challenges_system ON pow_challenges;
CREATE POLICY pow_challenges_system ON pow_challenges
  USING (current_setting('caelo.actor_kind', true) = 'system')
  WITH CHECK (current_setting('caelo.actor_kind', true) = 'system');

------------------------------------------------------------------------
-- 4. site_settings extensions — gateway, captcha, auto-redeploy.
------------------------------------------------------------------------
ALTER TABLE site_settings
  ADD COLUMN IF NOT EXISTS gateway_cookie_secret      text   NULL,
  ADD COLUMN IF NOT EXISTS gateway_max_body_bytes     int    NOT NULL DEFAULT 65536,
  ADD COLUMN IF NOT EXISTS auto_redeploy_enabled      bool   NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_redeploy_debounce_ms  int    NOT NULL DEFAULT 12000,
  ADD COLUMN IF NOT EXISTS auto_redeploy_op_kinds     text[] NOT NULL DEFAULT ARRAY[
    'pages.update', 'comments.moderate', 'media.publish', 'pages_seo.set_many'
  ],
  ADD COLUMN IF NOT EXISTS captcha_provider           text   NOT NULL DEFAULT 'pow',
  ADD COLUMN IF NOT EXISTS captcha_pow_target_prefix  text   NOT NULL DEFAULT '000fff',
  ADD COLUMN IF NOT EXISTS captcha_provider_config    jsonb  NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE site_settings DROP CONSTRAINT IF EXISTS site_settings_captcha_provider_check;
ALTER TABLE site_settings ADD CONSTRAINT site_settings_captcha_provider_check
  CHECK (captcha_provider IN ('off', 'pow', 'turnstile', 'hcaptcha'));

------------------------------------------------------------------------
-- 5. plugin_rate_limit_overrides — per-(plugin, op) overrides set by
--    Owner / approved AI proposals. NULL means "use plugin manifest
--    default"; a row means "override the manifest".
------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plugin_rate_limit_overrides (
  plugin_slug    text NOT NULL,
  operation      text NOT NULL,
  per_visitor_max int NOT NULL CHECK (per_visitor_max > 0),
  window_seconds  int NOT NULL CHECK (window_seconds BETWEEN 1 AND 3600),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid REFERENCES actors(id),
  PRIMARY KEY (plugin_slug, operation)
);

ALTER TABLE plugin_rate_limit_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE plugin_rate_limit_overrides FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS plugin_rate_limit_overrides_authenticated_scope
  ON plugin_rate_limit_overrides;
CREATE POLICY plugin_rate_limit_overrides_authenticated_scope
  ON plugin_rate_limit_overrides
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

------------------------------------------------------------------------
-- 6. plugin_rate_limit_proposals — §11.A propose/execute split.
--    AI tool `tune_rate_limit` writes here; Owner approves at
--    /security/gateway/pending.
------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plugin_rate_limit_proposals (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_slug         text NOT NULL,
  operation           text NOT NULL,
  proposed_max        int  NOT NULL,
  proposed_window_sec int  NOT NULL,
  proposed_by         uuid NOT NULL REFERENCES actors(id),
  status              text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'applied', 'rejected')),
  reason              text NOT NULL DEFAULT '',
  decided_at          timestamptz NULL,
  decided_by          uuid NULL REFERENCES actors(id),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS plugin_rate_limit_proposals_pending_idx
  ON plugin_rate_limit_proposals (status, created_at DESC) WHERE status = 'pending';

ALTER TABLE plugin_rate_limit_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE plugin_rate_limit_proposals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS plugin_rate_limit_proposals_authenticated_scope
  ON plugin_rate_limit_proposals;
CREATE POLICY plugin_rate_limit_proposals_authenticated_scope
  ON plugin_rate_limit_proposals
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);
