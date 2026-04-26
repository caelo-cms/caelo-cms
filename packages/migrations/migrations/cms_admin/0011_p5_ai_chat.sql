-- SPDX-License-Identifier: MPL-2.0
--
-- Phase 5: AI provider abstraction + chat surface + first AI module edit.
--
-- Six new tables:
--   site_ai_memory: Owner-curated brand voice / tone / banned phrases /
--     instructions / glossary, prepended to every system prompt.
--   ai_providers: provider config (name, model, etc). API keys live in
--     the secrets manager / env, never here.
--   chat_sessions: one preview branch per chat; engaged_skills filled by
--     P10A; published_at non-null once branch merged into main.
--   chat_messages: user / assistant / tool messages with token counts.
--   ai_calls: per-call accounting (provider, tokens, cost, duration).
--   site_memory_proposals: AI-proposed memory additions, Owner-reviewed.

------------------------------------------------------------------------
-- site_ai_memory
------------------------------------------------------------------------
CREATE TABLE site_ai_memory (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slot        text NOT NULL UNIQUE
              CHECK (slot IN ('brand-voice','tone','banned-phrases','instructions','glossary')),
  body        text NOT NULL,
  updated_by  uuid NOT NULL REFERENCES actors(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE site_ai_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_ai_memory FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS site_ai_memory_authenticated_scope ON site_ai_memory;
CREATE POLICY site_ai_memory_authenticated_scope ON site_ai_memory
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

--> statement-breakpoint

------------------------------------------------------------------------
-- ai_providers
------------------------------------------------------------------------
CREATE TABLE ai_providers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL UNIQUE
                CHECK (name IN ('anthropic','openai','google','local-openai-compat')),
  display_name  text NOT NULL,
  config        jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active     boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ai_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_providers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_providers_authenticated_scope ON ai_providers;
CREATE POLICY ai_providers_authenticated_scope ON ai_providers
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

--> statement-breakpoint

------------------------------------------------------------------------
-- chat_sessions
------------------------------------------------------------------------
CREATE TABLE chat_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title           text NOT NULL,
  created_by      uuid NOT NULL REFERENCES actors(id),
  chat_branch_id  uuid NOT NULL UNIQUE,
  engaged_skills  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_active_at  timestamptz NOT NULL DEFAULT now(),
  published_at    timestamptz NULL,
  archived_at     timestamptz NULL
);

CREATE INDEX chat_sessions_created_by_idx ON chat_sessions (created_by, last_active_at DESC);
CREATE INDEX chat_sessions_archived_idx ON chat_sessions (archived_at) WHERE archived_at IS NOT NULL;

ALTER TABLE chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS chat_sessions_authenticated_scope ON chat_sessions;
CREATE POLICY chat_sessions_authenticated_scope ON chat_sessions
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

--> statement-breakpoint

------------------------------------------------------------------------
-- chat_messages
------------------------------------------------------------------------
CREATE TABLE chat_messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_session_id  uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role             text NOT NULL CHECK (role IN ('user','assistant','tool')),
  content          text NOT NULL,
  tool_calls       jsonb NULL,
  tool_call_id     text NULL,
  tokens_in        integer NULL,
  tokens_out       integer NULL,
  cached_tokens    integer NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX chat_messages_session_idx ON chat_messages (chat_session_id, created_at);

ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS chat_messages_authenticated_scope ON chat_messages;
CREATE POLICY chat_messages_authenticated_scope ON chat_messages
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

--> statement-breakpoint

------------------------------------------------------------------------
-- ai_calls
------------------------------------------------------------------------
CREATE TABLE ai_calls (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_session_id          uuid NULL REFERENCES chat_sessions(id) ON DELETE SET NULL,
  actor_id                 uuid NOT NULL REFERENCES actors(id),
  provider                 text NOT NULL,
  model                    text NOT NULL,
  input_tokens             integer NOT NULL,
  output_tokens            integer NOT NULL,
  cached_tokens            integer NOT NULL DEFAULT 0,
  -- Microcents (×1e-8 USD) — bigint to dodge float drift.
  cost_estimate_microcents bigint NOT NULL DEFAULT 0,
  duration_ms              integer NOT NULL DEFAULT 0,
  succeeded                boolean NOT NULL DEFAULT true,
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ai_calls_actor_idx ON ai_calls (actor_id, created_at DESC);
CREATE INDEX ai_calls_created_idx ON ai_calls (created_at DESC);

ALTER TABLE ai_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_calls FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_calls_authenticated_scope ON ai_calls;
CREATE POLICY ai_calls_authenticated_scope ON ai_calls
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

--> statement-breakpoint

------------------------------------------------------------------------
-- site_memory_proposals
------------------------------------------------------------------------
CREATE TABLE site_memory_proposals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposed_by      uuid NOT NULL REFERENCES actors(id),
  chat_session_id  uuid NULL REFERENCES chat_sessions(id) ON DELETE SET NULL,
  slot             text NOT NULL
                   CHECK (slot IN ('brand-voice','tone','banned-phrases','instructions','glossary')),
  body             text NOT NULL,
  rationale        text NOT NULL,
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','accepted','rejected')),
  reviewed_by      uuid NULL REFERENCES actors(id),
  reviewed_at      timestamptz NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX site_memory_proposals_status_idx
  ON site_memory_proposals (status, created_at DESC);

ALTER TABLE site_memory_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_memory_proposals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS site_memory_proposals_authenticated_scope ON site_memory_proposals;
CREATE POLICY site_memory_proposals_authenticated_scope ON site_memory_proposals
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

--> statement-breakpoint

------------------------------------------------------------------------
-- Seed: the AI system actor that AI tool calls use as their actor_id.
-- Same id every dev DB so chat fixtures are deterministic.
------------------------------------------------------------------------
INSERT INTO actors (id, kind, display_name)
VALUES ('00000000-0000-0000-0000-000000000a1a', 'ai', 'Caelo AI')
ON CONFLICT (id) DO NOTHING;
