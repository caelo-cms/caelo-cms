-- SPDX-License-Identifier: MPL-2.0
--
-- 0267 — in-product Caelo updates (epic #696 Phase 2).
--
-- The Owner installs a signed Caelo release from Settings → Updates. The
-- admin never rolls anything itself: it writes a row to
-- `platform_update_requests` and starts the upgrader job, a Cloud Run job
-- with its own service account (packages/provisioning/src/upgrader-job.ts).
-- The job reads the oldest pending request, verifies the signed release
-- manifest, takes a backup, rolls admin + gateway, checks health, rolls back
-- on failure, and narrates every step into `platform_update_events`, which
-- the page renders as a live timeline (it survives an admin restart: the
-- admin that rolls is the admin that restarts).
--
-- Tables:
--   platform_update_requests  one row per install attempt (manual now;
--                             `trigger = 'auto'` is for Phase 5's scheduler)
--   platform_update_events    the job's progress lines, per request
--   platform_update_policy    singleton: the Owner's auto-update policy.
--                             Phase 5 drives the scheduler from it; the
--                             shape lands now so the job can already
--                             refuse what the policy forbids.
--
-- Database role `platform_updater` — the upgrader job connects with Cloud
-- SQL IAM database authentication as a member of it. It may read requests
-- and the policy, move a request through its run states, append events,
-- pause the policy after a failed automatic install, and write its own
-- audit rows. Nothing else: no users, no sessions, no content. Created like
-- 0239's operator_access_reader (needs CREATEROLE: Cloud SQL's admin_role
-- has it; locally bootstrap.sh creates the role as the superuser).
--
-- RLS lives here rather than in 9999_rls_policies.sql: the runner applies a
-- file once by name, so policies added to 9999 would never reach an
-- existing install.
--
-- Also: the `platform.update` permission (Owner by default) — installing a
-- Caelo release and changing the update policy. Both additionally need a
-- fresh Google sign-in (step-up, migration 0268).

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

INSERT INTO permissions (name, description) VALUES
  ('platform.update', 'Install Caelo updates and change the automatic-update policy (always confirmed with a fresh Google sign-in)')
ON CONFLICT (name) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'owner' AND p.name = 'platform.update'
ON CONFLICT DO NOTHING;

CREATE TABLE platform_update_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The release to install, SemVer without a leading v.
  target_version    text NOT NULL
                    CHECK (target_version ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'),
  -- What the admin ran when the request was made (informational: the job
  -- trusts the version recorded in the install's own state, not this).
  from_version      text NOT NULL CHECK (char_length(from_version) BETWEEN 1 AND 64),
  trigger           text NOT NULL CHECK (trigger IN ('manual', 'auto')),
  requested_by      uuid NULL REFERENCES actors(id) ON DELETE SET NULL,
  requested_at      timestamptz NOT NULL DEFAULT now(),
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN (
                      'pending',            -- waiting for the job
                      'running',            -- the job claimed it
                      'succeeded',          -- new release serving, healthy
                      'rolled_back',        -- rolled, unhealthy, traffic back on the old release
                      'failed',             -- stopped before or during the roll (see status_reason)
                      'refused',            -- not installable here (signature, downgrade, minFromVersion, policy)
                      'needs_cloud_shell',  -- needs the operator's own identity (infrastructure change)
                      'cancelled'           -- the Owner withdrew it before the job claimed it
                    )),
  -- Plain-language why for every end state but succeeded.
  status_reason     text NULL CHECK (char_length(status_reason) <= 4000),
  -- Machine-readable refusal codes (e.g. 'infra-contract', 'signature').
  refusal_codes     text[] NOT NULL DEFAULT '{}',
  -- Cloud Run execution that ran it (job side), for the log link.
  execution         text NULL CHECK (char_length(execution) <= 200),
  started_at        timestamptz NULL,
  finished_at       timestamptz NULL,
  -- From the signed release manifest, once verified.
  manifest_security boolean NULL,
  contract_migrations boolean NULL,
  infra_contract_required  integer NULL,
  infra_contract_installed integer NULL,
  admin_digest      text NULL CHECK (admin_digest ~ '^sha256:[0-9a-f]{64}$'),
  gateway_digest    text NULL CHECK (gateway_digest ~ '^sha256:[0-9a-f]{64}$'),
  ops_digest        text NULL CHECK (ops_digest ~ '^sha256:[0-9a-f]{64}$'),
  -- The pre-upgrade Cloud SQL backup.
  backup_id         text NULL CHECK (char_length(backup_id) <= 200),
  cancelled_by      uuid NULL REFERENCES actors(id) ON DELETE SET NULL,
  cancelled_at      timestamptz NULL,
  CHECK ((trigger = 'manual') <= (requested_by IS NOT NULL)),
  CHECK ((status = 'cancelled') <= (cancelled_at IS NOT NULL)),
  CHECK ((status IN ('succeeded', 'rolled_back', 'failed', 'refused', 'needs_cloud_shell', 'cancelled'))
         <= (finished_at IS NOT NULL))
);

-- At most one request in flight: a second click while one is pending or
-- running fails instead of queueing a surprise second upgrade.
CREATE UNIQUE INDEX platform_update_requests_one_active
  ON platform_update_requests ((true))
  WHERE status IN ('pending', 'running');
CREATE INDEX platform_update_requests_recent ON platform_update_requests (requested_at DESC);

CREATE TABLE platform_update_events (
  id          bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  request_id  uuid NOT NULL REFERENCES platform_update_requests(id) ON DELETE CASCADE,
  at          timestamptz NOT NULL DEFAULT now(),
  phase       text NOT NULL CHECK (phase IN (
                'queued', 'start', 'verify', 'assess', 'backup', 'health-baseline',
                'migrations', 'roll', 'health', 'rollback', 'record', 'self-update', 'finish'
              )),
  level       text NOT NULL CHECK (level IN ('info', 'success', 'warn', 'error')),
  message     text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 4000)
);
CREATE INDEX platform_update_events_request ON platform_update_events (request_id, id);

CREATE TABLE platform_update_policy (
  id                 smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- off: no update notice; notify: notice only; auto: install the kinds
  -- switched on below inside the maintenance window (Phase 5 scheduler).
  mode               text NOT NULL DEFAULT 'notify' CHECK (mode IN ('off', 'notify', 'auto')),
  auto_security      boolean NOT NULL DEFAULT false,
  auto_patch         boolean NOT NULL DEFAULT false,
  auto_minor         boolean NOT NULL DEFAULT false,
  -- Major releases are never installed automatically (pre-1.0 rule).
  channel            text NOT NULL DEFAULT 'stable' CHECK (channel IN ('stable', 'rc', 'beta', 'alpha')),
  -- Both NULL = any time. Local wall-clock times in window_timezone.
  window_start       time NULL,
  window_end         time NULL,
  window_timezone    text NOT NULL DEFAULT 'UTC' CHECK (char_length(window_timezone) BETWEEN 1 AND 64),
  soak_hours         integer NOT NULL DEFAULT 24 CHECK (soak_hours BETWEEN 0 AND 720),
  -- Set by the job after a failed automatic install; the Owner clears it.
  paused             boolean NOT NULL DEFAULT false,
  paused_reason      text NULL CHECK (char_length(paused_reason) <= 2000),
  paused_at          timestamptz NULL,
  updated_by         uuid NULL REFERENCES actors(id) ON DELETE SET NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK ((window_start IS NULL) = (window_end IS NULL)),
  CHECK (paused <= (paused_at IS NOT NULL))
);
INSERT INTO platform_update_policy (id) VALUES (1) ON CONFLICT DO NOTHING;

-- Authenticated actors only (every op runs with an actor kind); which
-- actor may do what is decided in the ops (Owner + step-up for writes).
ALTER TABLE platform_update_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_update_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_update_requests_authenticated_scope ON platform_update_requests
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

ALTER TABLE platform_update_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_update_events FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_update_events_authenticated_scope ON platform_update_events
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

ALTER TABLE platform_update_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_update_policy FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_update_policy_authenticated_scope ON platform_update_policy
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_updater')
     AND (SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user) THEN
    CREATE ROLE platform_updater NOLOGIN;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_updater') THEN
    EXECUTE 'GRANT CONNECT ON DATABASE cms_admin TO platform_updater';
    -- The query API opens a cms_public pool too and verifies its identity;
    -- the role reads nothing there.
    EXECUTE 'GRANT CONNECT ON DATABASE cms_public TO platform_updater';
    EXECUTE 'GRANT USAGE ON SCHEMA public TO platform_updater';
    EXECUTE 'GRANT SELECT ON platform_update_requests, platform_update_policy TO platform_updater';
    -- Run fields only: target, trigger and requester stay as the Owner set them.
    EXECUTE 'GRANT UPDATE (status, status_reason, refusal_codes, execution, started_at, finished_at,
      manifest_security, contract_migrations, infra_contract_required, infra_contract_installed,
      admin_digest, gateway_digest, ops_digest, backup_id) ON platform_update_requests TO platform_updater';
    EXECUTE 'GRANT INSERT ON platform_update_events TO platform_updater';
    -- Phase 5: a failed automatic install pauses automatic installs.
    EXECUTE 'GRANT UPDATE (paused, paused_reason, paused_at) ON platform_update_policy TO platform_updater';
    -- Its own audit rows (query-api recordAudit).
    EXECUTE 'GRANT INSERT ON audit_events TO platform_updater';
    -- Policies that do not depend on the session's caelo.actor_kind, like
    -- 0239's: the privileges above are what limits this role.
    EXECUTE 'CREATE POLICY platform_update_requests_updater ON platform_update_requests
      FOR ALL TO platform_updater USING (true) WITH CHECK (true)';
    EXECUTE 'CREATE POLICY platform_update_events_updater ON platform_update_events
      FOR INSERT TO platform_updater WITH CHECK (true)';
    EXECUTE 'CREATE POLICY platform_update_policy_updater ON platform_update_policy
      FOR ALL TO platform_updater USING (true) WITH CHECK (true)';
  END IF;
END
$$;

COMMIT;
