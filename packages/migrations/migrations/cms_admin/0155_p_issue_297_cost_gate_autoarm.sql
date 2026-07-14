-- SPDX-License-Identifier: MPL-2.0
--
-- 0155 — cost gate auto-arm (issue #297).
--
-- 1) One-shot claim stamps for the live budget gate. The chat-runner checks
--    rolled-up spend against the armed ceiling on every tool-loop iteration;
--    at >=80% it emits ONE chat warning, at >=100% it pauses the run. The
--    stamps make each transition exactly-once across parallel sessions
--    (claimed via UPDATE ... WHERE <stamp> IS NULL). imports.set_cost_ceiling
--    clears both on re-arm so the gate fires again at the NEW ceiling.
--
-- 2) ai_pricing rows for the current Anthropic model catalog. Root cause of
--    run #14's "$0.00 report despite 15+ ai_calls rows": migration 0048 only
--    seeded ('anthropic','claude-opus-4-7') — at stale $15/$75-per-MTok rates
--    on top — while the default chat model is 'claude-sonnet-5'. Every
--    recordAiCall lookup missed and silently stored cost 0, so the spend
--    roll-up (and therefore the whole cost gate) read a genuine-looking $0.
--    Values are microcents (1e-8 USD) PER 1K TOKENS at the current published
--    rates: sonnet-5 / sonnet-4-6 $3 in / $15 out / $0.30 cache-read per
--    MTok; opus-4-8 / 4-7 / 4-6 $5 / $25 / $0.50; haiku-4-5 $1 / $5 / $0.10;
--    fable-5 $10 / $50 / $1. The fresh opus-4-7 row supersedes the stale
--    0048 seed via effective_from ordering (history rows are kept by
--    design). Operators still tune rates at /security/ai/pricing; a future
--    lookup miss is now LOUD (stderr breadcrumb + unpricedCallCount in
--    imports.get_run_cost) instead of a silent $0.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE import_runs
  ADD COLUMN IF NOT EXISTS cost_warning_emitted_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS cost_gate_tripped_at    timestamptz NULL;

INSERT INTO ai_pricing (provider, model, operation_type, input_microcents, output_microcents, cached_microcents)
VALUES
  ('anthropic', 'claude-sonnet-5',   'text',  300000, 1500000,  30000),
  ('anthropic', 'claude-sonnet-4-6', 'text',  300000, 1500000,  30000),
  ('anthropic', 'claude-opus-4-8',   'text',  500000, 2500000,  50000),
  ('anthropic', 'claude-opus-4-7',   'text',  500000, 2500000,  50000),
  ('anthropic', 'claude-opus-4-6',   'text',  500000, 2500000,  50000),
  ('anthropic', 'claude-haiku-4-5',  'text',  100000,  500000,  10000),
  ('anthropic', 'claude-fable-5',    'text', 1000000, 5000000, 100000)
ON CONFLICT DO NOTHING;

COMMIT;
