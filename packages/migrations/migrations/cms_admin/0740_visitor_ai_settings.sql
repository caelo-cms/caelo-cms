-- SPDX-License-Identifier: MPL-2.0
--
-- 0740 — the visitor AI's settings (epic #1644, R4, issue #1654).
--
-- A plugin's `ai-chat` operation answers visitors in the public gateway, on
-- a key of its own and within budgets the Owner sets: the provider, the
-- model (the provider's fastest class unless the Owner picks another), the
-- daily, 30-day and per-conversation budgets, staging's own small daily
-- budget, the concurrent conversations, and ceilings that may lower each
-- plugin's limits. The AI proposes them through the owner-settings gate
-- (§11.A, kind `set_visitor_ai`); `visitor_ai.set` applies them.
--
-- The key is NEVER here (nor in cms_public): the Owner pastes it on the
-- approval card or in Settings → Visitor AI, the admin adds it as a version
-- of its own secret (Secret Manager `visitor-ai-key` / `visitor-ai-staging-key`,
-- add-version only; self-hosted a secret file), and only the gateway of
-- that environment reads it. This row records which provider each
-- environment's key is for and when it was set, so activation can refuse a
-- `requires: ["visitor-ai"]` plugin without one and the gateway knows it is
-- expected (`key_provider`, published).
--
-- Published to both gateways with the `settings` section (each its own
-- daily budget and key state): the triggers below mark it on every change,
-- and on an ai_pricing change, because the gateway prices the model from
-- the row published with it.
--
-- Also: owner_settings_pending_actions.kind gains `set_visitor_ai`, and
-- ai_calls.spender loses `plugin-visitor` (0730 reserved it for #1654; the
-- visitor AI runs in the gateway, which cannot reach cms_admin, and keeps
-- its own ledger in cms_public — no row ever carried the value).

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE IF NOT EXISTS visitor_ai_settings (
  id                              smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled                         boolean NOT NULL,
  provider                        text NOT NULL CHECK (provider IN ('anthropic', 'openai', 'google')),
  model                           text NOT NULL CHECK (model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$'),
  -- Microcents (1e-8 USD). Up to $100,000 a day: a typo in a budget is a
  -- bill, so the column refuses what no site needs.
  daily_budget_microcents         bigint NOT NULL
                                    CHECK (daily_budget_microcents BETWEEN 0 AND 10000000000000),
  monthly_budget_microcents       bigint NOT NULL
                                    CHECK (monthly_budget_microcents BETWEEN 0 AND 100000000000000),
  conversation_budget_microcents  bigint NOT NULL
                                    CHECK (conversation_budget_microcents BETWEEN 0 AND 10000000000),
  staging_daily_budget_microcents bigint NOT NULL
                                    CHECK (staging_daily_budget_microcents BETWEEN 0 AND 1000000000000),
  max_concurrent                  integer NOT NULL CHECK (max_concurrent BETWEEN 1 AND 500),
  -- NULL: the plugin's own limit. A value lowers it, never raises it.
  max_turns                       integer NULL CHECK (max_turns BETWEEN 1 AND 20),
  max_question_chars              integer NULL CHECK (max_question_chars BETWEEN 20 AND 2000),
  max_answer_tokens               integer NULL CHECK (max_answer_tokens BETWEEN 64 AND 2000),
  -- Which provider each environment's stored key is for; NULL: no key.
  live_key_provider               text NULL CHECK (live_key_provider IN ('anthropic', 'openai', 'google')),
  live_key_set_at                 timestamptz NULL,
  staging_key_provider            text NULL CHECK (staging_key_provider IN ('anthropic', 'openai', 'google')),
  staging_key_set_at              timestamptz NULL,
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  updated_by                      uuid NULL REFERENCES actors(id) ON DELETE SET NULL,
  CHECK (monthly_budget_microcents >= daily_budget_microcents)
);

CREATE INDEX IF NOT EXISTS visitor_ai_settings_updated_by_idx ON visitor_ai_settings (updated_by);

-- Defaults are data (CLAUDE.md §2): off, Claude's fastest model, $5 a day,
-- $50 per 30 days, 25 cents per conversation, $1 a day on staging, 20
-- conversations at once.
INSERT INTO visitor_ai_settings
  (id, enabled, provider, model, daily_budget_microcents, monthly_budget_microcents,
   conversation_budget_microcents, staging_daily_budget_microcents, max_concurrent)
VALUES (1, false, 'anthropic', 'claude-haiku-5-5', 500000000, 5000000000, 25000000, 100000000, 20)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE visitor_ai_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE visitor_ai_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS visitor_ai_settings_authenticated ON visitor_ai_settings;
CREATE POLICY visitor_ai_settings_authenticated ON visitor_ai_settings
  USING (caelo_setting_in('caelo.actor_kind', ARRAY['human', 'ai', 'system']))
  WITH CHECK (caelo_setting_in('caelo.actor_kind', ARRAY['human', 'ai', 'system']));

DROP TRIGGER IF EXISTS caelo_projection_settings_visitor_ai ON visitor_ai_settings;
CREATE TRIGGER caelo_projection_settings_visitor_ai
  AFTER INSERT OR UPDATE OR DELETE ON visitor_ai_settings FOR EACH STATEMENT
  EXECUTE FUNCTION caelo_mark_public_projection('settings');

DROP TRIGGER IF EXISTS caelo_projection_settings_ai_pricing ON ai_pricing;
CREATE TRIGGER caelo_projection_settings_ai_pricing
  AFTER INSERT OR UPDATE OR DELETE ON ai_pricing FOR EACH STATEMENT
  EXECUTE FUNCTION caelo_mark_public_projection('settings');

ALTER TABLE owner_settings_pending_actions
  DROP CONSTRAINT IF EXISTS owner_settings_pending_actions_kind_check;
ALTER TABLE owner_settings_pending_actions
  ADD CONSTRAINT owner_settings_pending_actions_kind_check
  CHECK (kind IN (
    'set_ai_budget',
    'set_ai_pricing',
    'set_gateway_settings',
    'set_translation_model',
    'set_plugin_ai_cost_cap',
    'rotate_gateway_cookie_secret',
    'set_staging_access',
    'rotate_staging_credentials',
    'set_staging_host',
    'set_mail_caps',
    'set_security_headers',
    'set_visitor_ai'
  ));

ALTER TABLE ai_calls DROP CONSTRAINT IF EXISTS ai_calls_spender_check;
ALTER TABLE ai_calls ADD CONSTRAINT ai_calls_spender_check CHECK (spender IN ('actor', 'plugin'));

COMMIT;
