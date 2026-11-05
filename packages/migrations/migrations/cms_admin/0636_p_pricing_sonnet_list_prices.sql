-- SPDX-License-Identifier: MPL-2.0
--
-- 0636 — two Anthropic list prices the ai_pricing seed has wrong.
--
-- Claude Sonnet 5: 0186 scheduled $3/$15 from 2026-09-01 after the
-- introductory $2/$10. Anthropic cancelled that increase: $2/$10 is the
-- standard price. Every Sonnet 5 call since then was costed about 50% high.
-- That covers the dated 2026-09-01 row and 0155's undated row at the same rate.
-- Claude Sonnet 5.5: cache hits are 0.05x input ($0.10 per MTok), not the
-- 0.1x 0224 assumed ($0.20).
--
-- Source: platform.claude.com/docs/en/about-claude/pricing, read 2026-11-05.
-- Values are microcents (1e-8 USD) PER 1K TOKENS. Rows an Owner has already
-- changed (ai_pricing.set) do not match the old values and stay as they are.
-- ai_calls rows keep the cost they were recorded with.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

UPDATE ai_pricing
SET input_microcents = 200000,
    output_microcents = 1000000,
    cached_microcents = 20000,
    cache_creation_microcents = 250000
WHERE provider = 'anthropic'
  AND model = 'claude-sonnet-5'
  AND operation_type = 'text'
  AND input_microcents = 300000
  AND output_microcents = 1500000;

UPDATE ai_pricing
SET cached_microcents = 10000
WHERE provider = 'anthropic'
  AND model = 'claude-sonnet-5-5'
  AND operation_type = 'text'
  AND cached_microcents = 20000;

COMMIT;
