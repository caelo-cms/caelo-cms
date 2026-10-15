-- SPDX-License-Identifier: MPL-2.0
--
-- 0280 — the API gateway's state moves to cms_public (issue #635,
-- CLAUDE.md §2: the public side has no path to cms_admin).
--
-- Two kinds of table, with opposite trust directions:
--
-- 1. GATEWAY-OWNED state, written by the gateway as public_role:
--
--      gateway_request_log         append only (the admin reads it for
--                                  /settings/gateway, as UNTRUSTED data)
--      gateway_rate_limit_buckets  the visitor rate-limit buckets
--      gateway_pow_challenges      captcha challenges: issue, claim once
--      gateway_plugin_op_events    the plugin op audit of visitor calls,
--                                  which the redeploy orchestrator polls
--                                  (as UNTRUSTED hints, never as audit
--                                  truth — that stays in cms_admin)
--
--    Every column is bounded by a CHECK: a compromised public side can
--    still write garbage, but not unbounded garbage, and the admin
--    validates every row it reads back (docs/dev/public-admin-boundary.md).
--    The gateway garbage-collects its own expired rows (it never needed
--    the admin to be awake for that — #763 L4).
--
-- 2. The PUBLISHED PROJECTION, written only by the admin (admin_role as
--    the `system` actor) and read by the gateway: exactly what serving
--    /api/* needs from authoring state, nothing else, one way:
--
--      published_gateway_settings  cookie secret, body cap, captcha
--      published_staging_access    the #650 staging gate settings + origin
--      published_rate_limits       per-op limits, profiles already resolved
--      published_plugins           the ACTIVE plugins: id, slug, tier,
--                                  version, actor, and for runtime-authored
--                                  ones their reviewed source + manifest
--      published_plugin_grants     unrevoked capability receipts of the
--                                  active installed artifacts
--      published_plugin_rows       each plugin's declared `visitorProjection`
--                                  of its private storage (main line only),
--                                  readable only under that plugin's id
--      published_comments          APPROVED comments (what the static pages
--                                  already show), for `list_approved`
--      published_projection_sections  which sections were published when,
--                                  so the gateway can tell "not published
--                                  yet" (a loud 503) from "empty"
--
--    public_role may only SELECT these. The admin never reads them back to
--    change its own state: the projection is a pure function of cms_admin,
--    republished whole (or per comment) from the source of truth.

-- ---------------------------------------------------------------------------
-- Gateway-owned state.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS gateway_request_log (
  id                  bigserial PRIMARY KEY,
  plugin_slug         text NOT NULL CHECK (length(plugin_slug) BETWEEN 1 AND 64),
  operation           text NOT NULL CHECK (length(operation) BETWEEN 1 AND 120),
  visitor_id_hash     text NOT NULL CHECK (length(visitor_id_hash) <= 64),
  status_code         int  NOT NULL CHECK (status_code BETWEEN 100 AND 599),
  duration_ms         int  NOT NULL CHECK (duration_ms >= 0),
  body_bytes          int  NOT NULL DEFAULT 0 CHECK (body_bytes >= 0),
  was_rate_limited    bool NOT NULL DEFAULT false,
  was_honeypot_caught bool NOT NULL DEFAULT false,
  captcha_passed      bool NOT NULL DEFAULT false,
  error_kind          text NULL CHECK (error_kind IS NULL OR length(error_kind) <= 64),
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gateway_request_log_created_idx
  ON gateway_request_log (created_at DESC);
CREATE INDEX IF NOT EXISTS gateway_request_log_plugin_idx
  ON gateway_request_log (plugin_slug, operation, created_at DESC);

CREATE TABLE IF NOT EXISTS gateway_rate_limit_buckets (
  key              text PRIMARY KEY CHECK (length(key) <= 400),
  window_start     timestamptz NOT NULL,
  count            int NOT NULL,
  expires_at       timestamptz NOT NULL,
  tokens_remaining int NOT NULL,
  last_refill_at   timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS gateway_rate_limit_buckets_expires_idx
  ON gateway_rate_limit_buckets (expires_at);

CREATE TABLE IF NOT EXISTS gateway_pow_challenges (
  challenge       text PRIMARY KEY CHECK (length(challenge) <= 64),
  target_hex      text NOT NULL CHECK (target_hex ~ '^[0-9a-f]{1,16}$'),
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz NULL,
  visitor_id_hash text NOT NULL CHECK (length(visitor_id_hash) <= 64),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gateway_pow_challenges_expires_idx
  ON gateway_pow_challenges (expires_at);

CREATE TABLE IF NOT EXISTS gateway_plugin_op_events (
  id          bigserial PRIMARY KEY,
  plugin_id   uuid NOT NULL,
  operation   text NOT NULL CHECK (operation ~ '^[a-z][a-z0-9-]{0,63}\.[a-z_][a-z0-9_]{0,119}$'),
  input_hash  text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  succeeded   bool NOT NULL,
  entity_id   uuid NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gateway_plugin_op_events_created_idx
  ON gateway_plugin_op_events (created_at);

-- ---------------------------------------------------------------------------
-- The published projection (admin → public, one way).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS published_projection_sections (
  section      text PRIMARY KEY CHECK (section ~ '^(settings|staging|rate_limits|plugins|comments|plugin:[0-9a-f-]{36})$'),
  published_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS published_gateway_settings (
  id                        smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  cookie_secret             text NOT NULL,
  max_body_bytes            int  NOT NULL,
  captcha_provider          text NOT NULL,
  captcha_pow_target_prefix text NOT NULL
);

CREATE TABLE IF NOT EXISTS published_staging_access (
  id                 smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  staging_host       text NULL,
  cookie_enabled     boolean NOT NULL,
  basic_auth_enabled boolean NOT NULL,
  basic_auth_user    text NOT NULL,
  basic_auth_nonce   text NULL,
  header_enabled     boolean NOT NULL,
  header_name        text NOT NULL,
  header_nonce       text NULL,
  ip_allowlist       jsonb NOT NULL,
  origin_url         text NULL
);

CREATE TABLE IF NOT EXISTS published_rate_limits (
  plugin_slug     text NOT NULL,
  operation       text NOT NULL,
  per_visitor_max int  NOT NULL,
  window_seconds  int  NOT NULL,
  PRIMARY KEY (plugin_slug, operation)
);

CREATE TABLE IF NOT EXISTS published_plugins (
  id            uuid PRIMARY KEY,
  slug          text NOT NULL UNIQUE,
  tier          smallint NOT NULL,
  version       text NOT NULL,
  actor_id      uuid NULL,
  manifest_json jsonb NULL,
  source_code   text NULL
);

CREATE TABLE IF NOT EXISTS published_plugin_grants (
  id              uuid PRIMARY KEY,
  plugin_id       uuid NOT NULL,
  artifact_digest text NOT NULL,
  capability      text NOT NULL
);

CREATE TABLE IF NOT EXISTS published_plugin_rows (
  plugin_id  uuid NOT NULL,
  table_name text NOT NULL,
  row_id     uuid NOT NULL,
  row        jsonb NOT NULL,
  PRIMARY KEY (plugin_id, table_name, row_id)
);

CREATE TABLE IF NOT EXISTS published_comments (
  id            uuid PRIMARY KEY,
  public_row_id uuid NOT NULL,
  page_id       uuid NOT NULL,
  parent_id     uuid NULL,
  author_name   text NOT NULL,
  content       text NOT NULL,
  submitted_at  timestamptz NOT NULL,
  archived_at   timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS published_comments_page_idx
  ON published_comments (page_id, archived_at);

-- ---------------------------------------------------------------------------
-- RLS (FORCEd for the owner too) + grants.
-- ---------------------------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'gateway_request_log', 'gateway_rate_limit_buckets', 'gateway_pow_challenges',
    'gateway_plugin_op_events', 'published_projection_sections', 'published_gateway_settings',
    'published_staging_access', 'published_rate_limits', 'published_plugins',
    'published_plugin_grants', 'published_plugin_rows', 'published_comments'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END
$$;

-- Gateway-owned: the gateway (public_role) writes; the admin (admin_role)
-- reads and may delete, as any authenticated actor.
DROP POLICY IF EXISTS gateway_request_log_gateway ON gateway_request_log;
CREATE POLICY gateway_request_log_gateway ON gateway_request_log
  FOR INSERT TO public_role WITH CHECK (true);
DROP POLICY IF EXISTS gateway_request_log_gc ON gateway_request_log;
CREATE POLICY gateway_request_log_gc ON gateway_request_log
  FOR DELETE TO public_role USING (created_at < now() - interval '90 days');
DROP POLICY IF EXISTS gateway_request_log_admin ON gateway_request_log;
CREATE POLICY gateway_request_log_admin ON gateway_request_log
  TO admin_role
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (false);

DROP POLICY IF EXISTS gateway_rate_limit_buckets_gateway ON gateway_rate_limit_buckets;
CREATE POLICY gateway_rate_limit_buckets_gateway ON gateway_rate_limit_buckets
  TO public_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS gateway_rate_limit_buckets_admin ON gateway_rate_limit_buckets;
CREATE POLICY gateway_rate_limit_buckets_admin ON gateway_rate_limit_buckets
  TO admin_role
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (false);

DROP POLICY IF EXISTS gateway_pow_challenges_gateway ON gateway_pow_challenges;
CREATE POLICY gateway_pow_challenges_gateway ON gateway_pow_challenges
  TO public_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS gateway_pow_challenges_admin ON gateway_pow_challenges;
CREATE POLICY gateway_pow_challenges_admin ON gateway_pow_challenges
  TO admin_role
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (false);

DROP POLICY IF EXISTS gateway_plugin_op_events_gateway ON gateway_plugin_op_events;
CREATE POLICY gateway_plugin_op_events_gateway ON gateway_plugin_op_events
  FOR INSERT TO public_role WITH CHECK (true);
DROP POLICY IF EXISTS gateway_plugin_op_events_gc ON gateway_plugin_op_events;
CREATE POLICY gateway_plugin_op_events_gc ON gateway_plugin_op_events
  FOR DELETE TO public_role USING (created_at < now() - interval '30 days');
DROP POLICY IF EXISTS gateway_plugin_op_events_admin ON gateway_plugin_op_events;
CREATE POLICY gateway_plugin_op_events_admin ON gateway_plugin_op_events
  TO admin_role
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (false);

GRANT INSERT, DELETE ON gateway_request_log TO public_role;
GRANT USAGE ON SEQUENCE gateway_request_log_id_seq TO public_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON gateway_rate_limit_buckets TO public_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON gateway_pow_challenges TO public_role;
GRANT INSERT, DELETE ON gateway_plugin_op_events TO public_role;
GRANT USAGE ON SEQUENCE gateway_plugin_op_events_id_seq TO public_role;
-- DELETE … WHERE created_at < … needs SELECT on the filtered column.
GRANT SELECT (created_at) ON gateway_request_log, gateway_plugin_op_events TO public_role;

-- Published projection: only the admin's `system` publisher writes it;
-- public_role reads it and nothing more.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'published_projection_sections', 'published_gateway_settings', 'published_staging_access',
    'published_rate_limits', 'published_plugins', 'published_plugin_grants',
    'published_plugin_rows', 'published_comments'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_publisher', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I TO admin_role USING (current_setting(''caelo.actor_kind'', true) = ''system'') WITH CHECK (current_setting(''caelo.actor_kind'', true) = ''system'')',
      t || '_publisher', t);
    IF t <> 'published_plugin_rows' THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_gateway_read', t);
      EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO public_role USING (true)',
        t || '_gateway_read', t);
    END IF;
    EXECUTE format('GRANT SELECT ON %I TO public_role', t);
  END LOOP;
END
$$;

-- A plugin's projected rows are readable only under that plugin's id, like
-- its own public tables (plugin-sandbox schemaFromSpec).
DROP POLICY IF EXISTS published_plugin_rows_gateway_read ON published_plugin_rows;
CREATE POLICY published_plugin_rows_gateway_read ON published_plugin_rows
  FOR SELECT TO public_role
  USING (plugin_id::text = NULLIF(current_setting('caelo.plugin_id', true), ''));
