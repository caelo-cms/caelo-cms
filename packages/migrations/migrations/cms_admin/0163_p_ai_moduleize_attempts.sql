-- SPDX-License-Identifier: MPL-2.0
--
-- 0163 — telemetry for the `moduleize` AI building block (HTML → module).
--
-- `moduleize` turns raw module HTML into a proper module (parametrised HTML +
-- a semantic `fields[]` schema) via a small, focused AI call, then validates
-- the result against the module contract (every {{field}} ↔ a declared field).
-- On a validation failure it feeds the error back to the model for up to two
-- repair passes, then fails loudly.
--
-- This table records ONLY the runs that needed a repair (attempts >= 2) — the
-- happy path (first-try valid) is NOT logged, so the table stays small. The
-- denominator for a retry-RATE comes from `ai_calls` (every moduleize call is
-- one ai_calls row), so retries-here / moduleize-calls-there gives the rate
-- without a row per run. Purpose: make silent-ish self-repairs auditable so a
-- systematic model/prompt/contract bug surfaces instead of hiding behind "it
-- fixed itself" (CLAUDE.md §4 — never write a failure off as flakiness).

CREATE TABLE ai_moduleize_attempts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- Nullable: moduleize may run outside a chat (import, background). No FK —
  -- this is append-only telemetry, not a referential-integrity anchor.
  chat_session_id  uuid,
  actor_id         uuid NOT NULL REFERENCES actors(id),
  -- The raw HTML the model was asked to moduleize + the caller's field hint.
  input_html       text NOT NULL,
  fields_hint      jsonb,
  -- >= 2 by construction: a row exists only because a retry happened.
  attempts         integer NOT NULL CHECK (attempts >= 2),
  -- One validation-error payload per failed attempt, in order.
  errors           jsonb NOT NULL DEFAULT '[]'::jsonb,
  outcome          text NOT NULL CHECK (outcome IN ('ok_after_repair', 'failed')),
  -- The fields[] the model ultimately produced (null when it never validated).
  final_fields     jsonb,
  model            text,
  cost_microcents  bigint NOT NULL DEFAULT 0
);

--> statement-breakpoint

CREATE INDEX ai_moduleize_attempts_outcome_idx ON ai_moduleize_attempts (outcome, created_at);

--> statement-breakpoint

-- RLS: authenticated-scope (any non-empty caelo.actor_kind session), matching
-- the other AI bookkeeping tables (site_ai_memory, ai_providers). FORCEd so
-- owners are scoped too. Fails closed on an unset GUC. Declared inline in this
-- migration — the prevailing pattern (9999_rls_policies.sql holds only the two
-- foundational tables actors/audit_events; every other table, incl.
-- site_ai_memory + ai_providers in 0011, declares its policy inline). The
-- migrate.ts drift check just requires a pg_policies row to exist, which this
-- provides.
ALTER TABLE ai_moduleize_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_moduleize_attempts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_moduleize_attempts_authenticated_scope ON ai_moduleize_attempts;
CREATE POLICY ai_moduleize_attempts_authenticated_scope ON ai_moduleize_attempts
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);
