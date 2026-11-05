-- SPDX-License-Identifier: MPL-2.0
--
-- 0637 — Claude Haiku 5.5 pricing, and prices that depend on prompt length (#1477).
--
-- model-catalog.json's `fast` slot moves to claude-haiku-5-5. Without a row
-- its calls would be recorded as `unpriced` (call-cost.ts). claude-haiku-4-5
-- keeps its row from 0155: existing installs call it until they take this
-- release, and ai_calls history refers to it.
--
-- List prices per MTok, https://platform.claude.com/docs/en/about-claude/pricing
-- (fetched 2026-11-05):
--   prompts up to 100,000 tokens: input $0.10, output $0.50,
--                                 5m cache write $0.125, cache read $0.01
--   prompts over 100,000 tokens:  input $0.50, output $2.50,
--                                 5m cache write $0.625, cache read $0.05
--
-- The page counts all of a request's input tokens towards its prompt length,
-- cache reads and cache writes included, and prices each request on its own:
-- every lane of a request over the threshold pays the higher rate. All four
-- lanes are exactly 5x, so one threshold + one integer multiplier states it.
-- Budget caps read these numbers, so the row must not carry only the low card.
--
-- Rate values are microcents (1e-8 USD) PER 1K TOKENS.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE ai_pricing
  ADD COLUMN IF NOT EXISTS long_prompt_threshold_tokens integer NULL,
  ADD COLUMN IF NOT EXISTS long_prompt_multiplier integer NULL;

ALTER TABLE ai_pricing
  DROP CONSTRAINT IF EXISTS ai_pricing_long_prompt_check;
ALTER TABLE ai_pricing
  ADD CONSTRAINT ai_pricing_long_prompt_check CHECK (
    (long_prompt_threshold_tokens IS NULL AND long_prompt_multiplier IS NULL)
    OR (long_prompt_threshold_tokens > 0 AND long_prompt_multiplier >= 2)
  );

INSERT INTO ai_pricing
  (provider, model, operation_type,
   input_microcents, output_microcents, cached_microcents, cache_creation_microcents,
   long_prompt_threshold_tokens, long_prompt_multiplier,
   effective_from, valid_from, valid_to)
VALUES
  ('anthropic', 'claude-haiku-5-5', 'text',
   10000, 50000, 1000, 12500,
   100000, 5,
   '2026-01-01T00:00:00Z', NULL, NULL)
ON CONFLICT (provider, model, operation_type, effective_from) DO NOTHING; -- an Owner's row stays

COMMIT;
