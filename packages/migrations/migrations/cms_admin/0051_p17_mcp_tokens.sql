-- SPDX-License-Identifier: MPL-2.0
--
-- P17 PR4 — MCP server tokens. Owner-managed; one row per "place I want
-- to talk to my Caelo install from" (laptop terminal, CI, Claude Code).
-- Mirrors `sessions` semantics but with longer TTL + explicit revoke +
-- per-token cost cap (P16 hardening pattern).

CREATE TABLE IF NOT EXISTS mcp_tokens (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The Caelo actor whose identity the bearer assumes. Always a human
  -- Owner — there's no AI-actor MCP path.
  actor_id               uuid NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  -- sha256 of the bearer secret. Plaintext is shown ONCE at create time
  -- and never persisted in the clear.
  token_hash             text NOT NULL UNIQUE,
  -- Owner-supplied label so the registry table is readable.
  display_name           text NOT NULL,
  -- NULL = uncapped. Microcents (USD × 1e8) — same units as ai_calls.
  ai_cost_cap_microcents bigint NULL,
  last_used_at           timestamptz NULL,
  revoked_at             timestamptz NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  expires_at             timestamptz NOT NULL DEFAULT (now() + interval '90 days')
);

CREATE INDEX IF NOT EXISTS mcp_tokens_actor_idx
  ON mcp_tokens (actor_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS mcp_tokens_token_hash_idx
  ON mcp_tokens (token_hash) WHERE revoked_at IS NULL;

ALTER TABLE mcp_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_tokens FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mcp_tokens_authenticated_scope ON mcp_tokens;
CREATE POLICY mcp_tokens_authenticated_scope ON mcp_tokens
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (current_setting('caelo.actor_kind', true) IN ('human','system'));
