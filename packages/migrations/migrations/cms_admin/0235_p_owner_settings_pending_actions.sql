-- SPDX-License-Identifier: MPL-2.0
--
-- 0235 — owner_settings_pending_actions: the §11.A propose/execute gate for
-- the Owner-only settings the agent had no path to at all.
--
-- AI budgets (ai_budgets.set), AI pricing (ai_pricing.set) and the gateway
-- knobs (gateway.set_settings: captcha, body cap, auto-redeploy) stayed
-- human-only, so an agent that hit "no pricing row for this model" or a
-- budget cap could only tell the operator to leave the chat and find
-- /security/ai/pricing. Each is a money / public-attack-surface decision —
-- hard to undo after the fact — so instead of opening them to the AI they
-- join the gate: the AI proposes, the operator approves in the chat (or at
-- /security/owner-settings/pending for proposals queued over the Power-MCP),
-- and owner_settings.execute_proposal applies the existing op.
--
-- One table with a `kind` discriminator rather than three: the three
-- payloads are small settings rows with no entity FK, and one table means
-- one stanza in each piece of cross-domain plumbing (inbox, bell, GC,
-- cancel). Shape mirrors the v0.2.35 unified pending tables.
--
-- Also fixes the write policies on ai_budgets / ai_pricing. Since 0048 their
-- WITH CHECK admitted only `actor_kind = 'system'`, but the writers are
-- `ai_budgets.set` / `ai_pricing.set`, whose actorScope is human+system and
-- whose only callers are the Owner's /security/ai/budgets and
-- /security/ai/pricing forms — running as the human actor. Every save from
-- those forms was therefore RLS-denied (surfaced as "could not save"); the
-- integration tests never noticed because they write as system. Writes are
-- now admitted for human + system: the op layer still keeps the AI out
-- (the AI reaches these only through the approve-gated proposal above), and
-- the policy keeps it out at the database layer too.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE IF NOT EXISTS owner_settings_pending_actions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL
                   CHECK (kind IN ('set_ai_budget', 'set_ai_pricing', 'set_gateway_settings')),
  proposed_by      uuid NOT NULL REFERENCES actors(id),
  payload          jsonb NOT NULL,
  preview          jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'applied', 'rejected', 'superseded', 'cancelled')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  decided_at       timestamptz NULL,
  decided_by       uuid NULL REFERENCES actors(id),
  decision_reason  text NULL,
  chat_session_id  uuid NULL REFERENCES chat_sessions(id) ON DELETE SET NULL,
  payload_hash     text NULL
);

CREATE INDEX IF NOT EXISTS owner_settings_pending_actions_status_idx
  ON owner_settings_pending_actions (status, created_at DESC);

-- Block AI from re-proposing the same payload while one is still pending.
CREATE UNIQUE INDEX IF NOT EXISTS owner_settings_pending_actions_payload_hash_pending_uniq
  ON owner_settings_pending_actions (payload_hash)
  WHERE status = 'pending' AND payload_hash IS NOT NULL;

ALTER TABLE owner_settings_pending_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_settings_pending_actions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_settings_pending_actions_authenticated_scope
  ON owner_settings_pending_actions;
CREATE POLICY owner_settings_pending_actions_authenticated_scope
  ON owner_settings_pending_actions
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

DROP POLICY IF EXISTS ai_budgets_authed ON ai_budgets;
CREATE POLICY ai_budgets_authed ON ai_budgets
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (current_setting('caelo.actor_kind', true) IN ('human', 'system'));

DROP POLICY IF EXISTS ai_pricing_authed ON ai_pricing;
CREATE POLICY ai_pricing_authed ON ai_pricing
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (current_setting('caelo.actor_kind', true) IN ('human', 'system'));

COMMIT;
