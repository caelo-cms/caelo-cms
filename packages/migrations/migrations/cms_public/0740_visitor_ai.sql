-- SPDX-License-Identifier: MPL-2.0
--
-- 0740 — the visitor AI on the public side (epic #1644, R4, issue #1654).
--
--   published_visitor_ai             the Owner's settings for this
--       environment (cms_admin 0740), published with the `settings`
--       section: provider, model, the rates of that model, the budgets
--       (staging's database gets staging's own small daily budget), the
--       concurrent conversations, the ceilings, and which provider this
--       environment's stored key is for. Never the key.
--   published_plugin_visitor_config  each active plugin's visitor-visible
--       configuration (the leaves its manifest marks `visitorVisible`),
--       published with the `plugins` section from the run the pointer
--       names: an ai-chat prompt changes with a Stage and goes live with
--       Publish live.
--   visitor_ai_calls                 the gateway's spend ledger. Each turn
--       reserves its worst case before any token flows (`reserved`),
--       settles to its real cost (`settled`) or is released when it failed
--       before the provider billed (`released`). The gateway writes it under
--       one advisory lock, so concurrent conversations cannot pass a budget
--       only one fits under; the admin reads it for the cost dashboard, as
--       untrusted data (#635: everything here is attacker-writable).
--
-- Expand-only: new tables the previous release does not read.

CREATE TABLE IF NOT EXISTS published_visitor_ai (
  id                          smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled                     boolean NOT NULL,
  provider                    text NOT NULL,
  model                       text NOT NULL,
  pricing                     jsonb NULL,
  daily_cap_microcents        bigint NOT NULL,
  monthly_cap_microcents      bigint NOT NULL,
  conversation_cap_microcents bigint NOT NULL,
  max_concurrent              integer NOT NULL,
  max_turns                   integer NULL,
  max_question_chars          integer NULL,
  max_answer_tokens           integer NULL,
  key_provider                text NULL
);

CREATE TABLE IF NOT EXISTS published_plugin_visitor_config (
  plugin_id uuid PRIMARY KEY,
  "values"  jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS visitor_ai_calls (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_id           uuid NOT NULL,
  operation           text NOT NULL CHECK (operation ~ '^[a-z_][a-z0-9_]{0,119}$'),
  conversation_id     text NOT NULL CHECK (conversation_id ~ '^[A-Za-z0-9_-]{22}$'),
  reservation         text NOT NULL CHECK (reservation IN ('reserved', 'settled', 'released')),
  reserved_microcents bigint NOT NULL CHECK (reserved_microcents >= 0),
  cost_microcents     bigint NOT NULL DEFAULT 0 CHECK (cost_microcents >= 0),
  input_tokens        integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens       integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  steps               smallint NOT NULL DEFAULT 0 CHECK (steps BETWEEN 0 AND 8),
  model               text NOT NULL CHECK (length(model) <= 120),
  created_at          timestamptz NOT NULL DEFAULT now(),
  settled_at          timestamptz NULL
);

-- The rolling 24-hour and 30-day sums, the per-conversation sum and the
-- open reservations (concurrent conversations) each read one index.
CREATE INDEX IF NOT EXISTS visitor_ai_calls_created_idx ON visitor_ai_calls (created_at);
CREATE INDEX IF NOT EXISTS visitor_ai_calls_conversation_idx
  ON visitor_ai_calls (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS visitor_ai_calls_open_idx
  ON visitor_ai_calls (created_at) WHERE reservation = 'reserved';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['published_visitor_ai', 'published_plugin_visitor_config', 'visitor_ai_calls'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END
$$;

-- Published: only the admin's `system` publisher writes; the gateway reads.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['published_visitor_ai', 'published_plugin_visitor_config'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_publisher', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I TO admin_role USING (caelo_setting_is(''caelo.actor_kind'', ''system'')) WITH CHECK (caelo_setting_is(''caelo.actor_kind'', ''system''))',
      t || '_publisher', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_gateway_read', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO public_role USING (true)',
      t || '_gateway_read', t);
    EXECUTE format('GRANT SELECT ON %I TO public_role', t);
  END LOOP;
END
$$;

-- Gateway-owned: the gateway reserves, settles and releases; it may delete
-- what is older than any budget window and the dashboard's year. The admin
-- reads, as any authenticated actor, and writes nothing.
DROP POLICY IF EXISTS visitor_ai_calls_gateway ON visitor_ai_calls;
CREATE POLICY visitor_ai_calls_gateway ON visitor_ai_calls
  FOR SELECT TO public_role USING (true);
DROP POLICY IF EXISTS visitor_ai_calls_gateway_reserve ON visitor_ai_calls;
CREATE POLICY visitor_ai_calls_gateway_reserve ON visitor_ai_calls
  FOR INSERT TO public_role WITH CHECK (reservation = 'reserved');
DROP POLICY IF EXISTS visitor_ai_calls_gateway_settle ON visitor_ai_calls;
CREATE POLICY visitor_ai_calls_gateway_settle ON visitor_ai_calls
  FOR UPDATE TO public_role USING (reservation = 'reserved')
  WITH CHECK (reservation IN ('reserved', 'settled', 'released'));
DROP POLICY IF EXISTS visitor_ai_calls_gc ON visitor_ai_calls;
CREATE POLICY visitor_ai_calls_gc ON visitor_ai_calls
  FOR DELETE TO public_role USING (created_at < now() - interval '400 days');
DROP POLICY IF EXISTS visitor_ai_calls_admin ON visitor_ai_calls;
CREATE POLICY visitor_ai_calls_admin ON visitor_ai_calls
  FOR SELECT TO admin_role
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

-- The writer chooses neither the id nor the time: both come from defaults.
GRANT SELECT, DELETE ON visitor_ai_calls TO public_role;
GRANT INSERT (plugin_id, operation, conversation_id, reservation, reserved_microcents, model)
  ON visitor_ai_calls TO public_role;
GRANT UPDATE (reservation, reserved_microcents, cost_microcents, input_tokens, output_tokens,
              steps, settled_at)
  ON visitor_ai_calls TO public_role;
