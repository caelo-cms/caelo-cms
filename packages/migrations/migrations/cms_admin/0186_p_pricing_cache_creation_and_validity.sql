-- SPDX-License-Identifier: MPL-2.0
--
-- 0186 — cache-CREATION pricing + validity-dated ai_pricing rows.
--
-- Two cost-accuracy gaps closed:
--
-- Fix 1 — price cache WRITES. Anthropic bills `cache_creation_input_tokens`
--   at ~1.25x the input rate. Until now ai_pricing carried only input /
--   output / cache-READ rates, so cache writes went either unbilled or, worse,
--   double-billed at the input rate (the SDK's flat `inputTokens` is the grand
--   total of fresh + cache-read + cache-write — see call-cost.ts). We add
--   `ai_calls.cache_creation_tokens` (the counter) + `ai_pricing.
--   cache_creation_microcents` (the per-1K rate) and backfill every existing
--   row's rate to 1.25x its input rate.
--
-- Fix 2 — validity-dated pricing. Sonnet-5 ships at intro pricing ($2/$10 per
--   MTok, cache-read $0.20/MTok, cache-write $2.50/MTok) through 2026-08-31,
--   reverting to standard ($3/$15, cache-read $0.30, cache-write $3.75) on
--   2026-09-01. One undated row per (provider, model, op) cannot represent
--   that, so we add `[valid_from, valid_to]` window columns (NULL = open-
--   ended) and seed two dated Sonnet-5 rows. The lookup (pricing-cache.ts)
--   picks the row whose window contains the call time, preferring a dated
--   window over the undated back-compat row.
--
-- Constraint note: ai_pricing's only uniqueness is its PRIMARY KEY
-- (provider, model, operation_type, effective_from) — there is NO separate
-- UNIQUE(provider, model, operation_type). Two dated Sonnet-5 rows therefore
-- coexist simply by carrying distinct effective_from values; no constraint
-- needs dropping or replacing.
--
-- Values are microcents (1e-8 USD) PER 1K TOKENS.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

-- Fix 1 — counter on ai_calls + rate on ai_pricing.
ALTER TABLE ai_calls
  ADD COLUMN IF NOT EXISTS cache_creation_tokens integer NOT NULL DEFAULT 0;

ALTER TABLE ai_pricing
  ADD COLUMN IF NOT EXISTS cache_creation_microcents bigint NULL;

-- Fix 2 — validity window (NULL bound = open-ended).
ALTER TABLE ai_pricing
  ADD COLUMN IF NOT EXISTS valid_from timestamptz NULL,
  ADD COLUMN IF NOT EXISTS valid_to   timestamptz NULL;

-- Backfill: price cache writes everywhere at 1.25x the input rate, so no
-- existing model's cache writes stay unbilled.
UPDATE ai_pricing
  SET cache_creation_microcents = round(input_microcents * 1.25)::bigint
  WHERE cache_creation_microcents IS NULL;

-- Sonnet-5 intro (through 2026-08-31) + standard (from 2026-09-01) rows.
-- Distinct effective_from keeps both under the existing PK; the lookup uses
-- the [valid_from, valid_to] window to pick the one in force at call time.
INSERT INTO ai_pricing
  (provider, model, operation_type,
   input_microcents, output_microcents, cached_microcents, cache_creation_microcents,
   effective_from, valid_from, valid_to)
VALUES
  ('anthropic', 'claude-sonnet-5', 'text',
   200000, 1000000, 20000, 250000,
   '2026-07-01T00:00:00Z', NULL, '2026-08-31T23:59:59Z'),
  ('anthropic', 'claude-sonnet-5', 'text',
   300000, 1500000, 30000, 375000,
   '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', NULL)
ON CONFLICT (provider, model, operation_type, effective_from) DO UPDATE
  SET input_microcents          = EXCLUDED.input_microcents,
      output_microcents         = EXCLUDED.output_microcents,
      cached_microcents         = EXCLUDED.cached_microcents,
      cache_creation_microcents = EXCLUDED.cache_creation_microcents,
      valid_from                = EXCLUDED.valid_from,
      valid_to                  = EXCLUDED.valid_to;

COMMIT;
