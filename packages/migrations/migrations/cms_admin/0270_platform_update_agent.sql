-- SPDX-License-Identifier: MPL-2.0
--
-- 0270 — the self-hosted update agent (epic #696 Phase 4c).
--
-- On a self-hosted install "Install update" is carried out by `caelo-agent`,
-- a systemd timer on the install's host that runs the provisioning CLI as
-- the host's operator user (packages/provisioning/src/agent/). No container
-- gets the Docker socket: the agent polls `platform_update_requests` over a
-- Postgres port published to 127.0.0.1 only, logged in as `caelo_agent`, a
-- member of `platform_updater` (migration 0267) — the same role and the same
-- job ops the Google Cloud upgrader job uses.
--
-- `platform_update_agent` is its heartbeat: one row the agent rewrites on
-- every poll. The admin offers "Install update" only while it is recent, and
-- shows the agent's own preflight problem (no cosign, no Docker access)
-- before the Owner clicks.
--
-- Also: `caelo_grant_platform_updater()`, which (re)applies 0267's grants
-- and this migration's. On a self-hosted database 0267 usually granted
-- nothing: admin_role has no CREATEROLE there and nothing had created the
-- role yet. So the provisioning CLI's role convergence (`up`, `agent
-- install`, the install's bootstrap script) creates `platform_updater` +
-- `caelo_agent` as the superuser and then calls this function — the same
-- convergence as 0248's caelo_grant_gateway_role().

CREATE TABLE IF NOT EXISTS platform_update_agent (
  id             smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- The Caelo release of the agent's own code.
  agent_version  text NOT NULL CHECK (agent_version ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'),
  host           text NOT NULL CHECK (char_length(host) BETWEEN 1 AND 255),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  -- Why an install would fail on the host right now; NULL when its
  -- preflight (Docker reachable, cosign present, a recorded release) passed.
  problem        text NULL CHECK (char_length(problem) <= 2000)
);

ALTER TABLE platform_update_agent ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_update_agent FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_update_agent_authenticated_scope ON platform_update_agent;
CREATE POLICY platform_update_agent_authenticated_scope ON platform_update_agent
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

CREATE OR REPLACE FUNCTION caelo_grant_platform_updater() RETURNS void
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_updater') THEN
    RETURN;
  END IF;

  -- 0267's grants, verbatim.
  EXECUTE 'GRANT CONNECT ON DATABASE cms_admin TO platform_updater';
  EXECUTE 'GRANT CONNECT ON DATABASE cms_public TO platform_updater';
  GRANT USAGE ON SCHEMA public TO platform_updater;
  GRANT SELECT ON platform_update_requests, platform_update_policy TO platform_updater;
  GRANT UPDATE (status, status_reason, refusal_codes, execution, started_at, finished_at,
    manifest_security, contract_migrations, infra_contract_required, infra_contract_installed,
    admin_digest, gateway_digest, ops_digest, backup_id) ON platform_update_requests TO platform_updater;
  GRANT INSERT ON platform_update_events TO platform_updater;
  GRANT UPDATE (paused, paused_reason, paused_at) ON platform_update_policy TO platform_updater;
  GRANT INSERT ON audit_events TO platform_updater;
  DROP POLICY IF EXISTS platform_update_requests_updater ON platform_update_requests;
  CREATE POLICY platform_update_requests_updater ON platform_update_requests
    FOR ALL TO platform_updater USING (true) WITH CHECK (true);
  DROP POLICY IF EXISTS platform_update_events_updater ON platform_update_events;
  CREATE POLICY platform_update_events_updater ON platform_update_events
    FOR INSERT TO platform_updater WITH CHECK (true);
  DROP POLICY IF EXISTS platform_update_policy_updater ON platform_update_policy;
  CREATE POLICY platform_update_policy_updater ON platform_update_policy
    FOR ALL TO platform_updater USING (true) WITH CHECK (true);

  -- The heartbeat: the agent upserts its one row and nothing else here.
  GRANT SELECT, INSERT, UPDATE ON platform_update_agent TO platform_updater;
  DROP POLICY IF EXISTS platform_update_agent_updater ON platform_update_agent;
  CREATE POLICY platform_update_agent_updater ON platform_update_agent
    FOR ALL TO platform_updater USING (true) WITH CHECK (true);
END
$fn$;

-- Only the migration runner and the superuser's role convergence call it.
REVOKE ALL ON FUNCTION caelo_grant_platform_updater() FROM PUBLIC;

SELECT caelo_grant_platform_updater();
