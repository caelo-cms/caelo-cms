-- SPDX-License-Identifier: MPL-2.0
--
-- 0140 — migration cost gate (issue #280): the operator-confirmed money
-- ceiling for a migration run. When the operator says "this migration may
-- cost up to €10", the AI records the ceiling here; live spend is summed
-- from ai_calls across the run's orchestrator chat session + every
-- subagent session at read time (imports.get_run_cost), so the ceiling is
-- the only new stored state.
--
-- cost_ceiling_microcents uses the SAME unit ai_calls records in — one
-- microcent = 1e-8 USD (see 0048 ai_pricing) — so stored spend and the
-- ceiling compare directly without an FX round-trip. cost_ceiling_currency
-- is the label the operator confirmed the budget in ("EUR", "USD") and is
-- carried for honest display: Caelo has no FX-rate source yet, so spend is
-- reported in USD-major and the label is display-only until a rate lands
-- (currency-conversion gap tracked on PR for #280). Both nullable: a run
-- gets a ceiling only once the operator confirms one at plan time.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE import_runs
  ADD COLUMN IF NOT EXISTS cost_ceiling_microcents bigint NULL,
  ADD COLUMN IF NOT EXISTS cost_ceiling_currency   text   NULL;

COMMIT;
