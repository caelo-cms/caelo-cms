-- SPDX-License-Identifier: MPL-2.0
--
-- 0241 — configurable translation model (#593).
--
-- Plugin AI calls (ctx.ai.complete) all ran on the active provider's chat
-- model. Translation is the bulk consumer, and an Owner may want a cheaper
-- model for it. `ai_providers.translation_model` holds that choice per
-- provider, because a model id only means something to the provider that
-- serves it: switching the active provider never sends a Claude id to
-- OpenAI, the other provider's row simply has its own (usually NULL) value.
--
-- NULL means "same as the chat model". That is the stored default, read
-- as such by the resolver — not a silent recovery from missing data.
--
-- The column is a real column rather than a key inside `config` so the
-- inherit state is an explicit NULL and the Owner's provider form (which
-- rewrites `config` wholesale) can never drop it by accident.
--
-- Also widens owner_settings_pending_actions.kind: the AI proposes a
-- translation model through the §11.A owner-settings gate (#578), since
-- the choice changes what every translation costs.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE ai_providers
  ADD COLUMN IF NOT EXISTS translation_model text NULL;

ALTER TABLE ai_providers
  DROP CONSTRAINT IF EXISTS ai_providers_translation_model_format;
ALTER TABLE ai_providers
  ADD CONSTRAINT ai_providers_translation_model_format
  CHECK (translation_model IS NULL OR translation_model ~ '^[A-Za-z0-9._:/-]{1,128}$');

COMMENT ON COLUMN ai_providers.translation_model IS
  'Model for plugin AI calls declared purpose=translation. NULL = same as the chat model (config.model).';

ALTER TABLE owner_settings_pending_actions
  DROP CONSTRAINT IF EXISTS owner_settings_pending_actions_kind_check;
ALTER TABLE owner_settings_pending_actions
  ADD CONSTRAINT owner_settings_pending_actions_kind_check
  CHECK (kind IN ('set_ai_budget', 'set_ai_pricing', 'set_gateway_settings', 'set_translation_model'));

COMMIT;
