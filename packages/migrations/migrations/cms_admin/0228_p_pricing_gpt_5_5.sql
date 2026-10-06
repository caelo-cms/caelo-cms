-- SPDX-License-Identifier: MPL-2.0
--
-- 0228 — GPT-5.5 pricing.
--
-- OpenAI Standard pricing for GPT-5.5 short context (<272K input tokens),
-- per 1M tokens: input $5.00, cached input $0.50, output $30.00.
-- Source: https://platform.openai.com/docs/pricing
-- (redirects to https://developers.openai.com/api/docs/pricing)
-- The listed cache-write price is "-", so cache writes use the input rate.
--
-- Values below are microcents (1e-8 USD) PER 1K TOKENS.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

INSERT INTO ai_pricing
  (provider, model, operation_type,
   input_microcents, output_microcents, cached_microcents, cache_creation_microcents,
   effective_from, valid_from, valid_to)
VALUES
  ('openai', 'gpt-5.5', 'text',
   500000, 3000000, 50000, 500000,
   '2026-10-06T00:00:00Z', NULL, NULL)
ON CONFLICT (provider, model, operation_type, effective_from) DO UPDATE
  SET input_microcents          = EXCLUDED.input_microcents,
      output_microcents         = EXCLUDED.output_microcents,
      cached_microcents         = EXCLUDED.cached_microcents,
      cache_creation_microcents = EXCLUDED.cache_creation_microcents,
      valid_from                = EXCLUDED.valid_from,
      valid_to                  = EXCLUDED.valid_to;

COMMIT;
