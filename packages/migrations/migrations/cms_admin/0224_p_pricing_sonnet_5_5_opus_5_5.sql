-- SPDX-License-Identifier: MPL-2.0
--
-- 0215 — pricing for the models model-catalog.json now defaults to.
--
-- The catalog's Anthropic slots moved to Claude Sonnet 5.5 (default) and
-- Claude Opus 5.5 (capable). Without a row here their calls would be recorded
-- as `unpriced` (call-cost.ts). Claude Haiku 4.5 (fast) is already priced.
--
-- Anthropic list prices per MTok:
--   claude-sonnet-5-5  input $2, output $10, cache read $0.20, cache write $2.50
--   claude-opus-5-5    input $4, output $20, cache read $0.20, cache write $5.00
-- Cache writes follow 0186's convention of 1.25x the input rate.
--
-- Values are microcents (1e-8 USD) PER 1K TOKENS.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

INSERT INTO ai_pricing
  (provider, model, operation_type,
   input_microcents, output_microcents, cached_microcents, cache_creation_microcents,
   effective_from, valid_from, valid_to)
VALUES
  ('anthropic', 'claude-sonnet-5-5', 'text',
   200000, 1000000, 20000, 250000,
   '2026-01-01T00:00:00Z', NULL, NULL),
  ('anthropic', 'claude-opus-5-5', 'text',
   400000, 2000000, 20000, 500000,
   '2026-01-01T00:00:00Z', NULL, NULL)
ON CONFLICT (provider, model, operation_type, effective_from) DO UPDATE
  SET input_microcents          = EXCLUDED.input_microcents,
      output_microcents         = EXCLUDED.output_microcents,
      cached_microcents         = EXCLUDED.cached_microcents,
      cache_creation_microcents = EXCLUDED.cache_creation_microcents,
      valid_from                = EXCLUDED.valid_from,
      valid_to                  = EXCLUDED.valid_to;

COMMIT;
