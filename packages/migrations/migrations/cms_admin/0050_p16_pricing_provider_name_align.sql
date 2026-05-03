-- SPDX-License-Identifier: MPL-2.0
--
-- P16 review-pass — align ai_pricing.provider strings with the canonical
-- ai_providers.name enum (`anthropic` | `openai` | `google` | `local-openai-compat`).
-- Migration 0048 seeded `gemini` and `openai-compatible` which silently miss
-- when recordAiCall does the (provider, model) lookup → all Gemini + local
-- calls would price at $0.
--
-- Idempotent: ON CONFLICT DO NOTHING handles re-applies.

UPDATE ai_pricing SET provider = 'google'             WHERE provider = 'gemini';
UPDATE ai_pricing SET provider = 'local-openai-compat' WHERE provider = 'openai-compatible';
