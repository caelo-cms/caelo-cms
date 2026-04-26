-- SPDX-License-Identifier: MPL-2.0
--
-- Phase 6: static generator + local deploy.
--
-- Two tables:
--   deploy_targets — one row per env (dev, staging, production). Holds the
--     output directory, robots policy, and an explicit `is_default` so the
--     editor "Publish" button knows which target to ship to without the
--     editor seeing the env model.
--   deploy_runs — one row per build. The op handler creates a row at start,
--     spawns the generator synchronously, then updates with the outcome.
--     deploy_runs *is* the audit trail for builds — no separate audit row.
--
-- Trigger-only: AI is allowed to call the deploy.trigger op (its actorScope
-- includes 'ai') but cannot reach the generator binary or modify these
-- tables — see CMS_REQUIREMENTS §3.1 "Deployment Layer: Trigger-only".

------------------------------------------------------------------------
-- deploy_targets
------------------------------------------------------------------------
CREATE TABLE deploy_targets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL UNIQUE,
  env             text NOT NULL CHECK (env IN ('dev','staging','production')),
  out_dir         text NOT NULL,
  base_url        text NOT NULL DEFAULT 'http://localhost',
  robots_default  text NOT NULL DEFAULT 'index'
                  CHECK (robots_default IN ('index','noindex')),
  is_default      boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- At most one default target across the table.
CREATE UNIQUE INDEX deploy_targets_one_default ON deploy_targets ((true)) WHERE is_default;

ALTER TABLE deploy_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE deploy_targets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deploy_targets_authenticated_scope ON deploy_targets;
CREATE POLICY deploy_targets_authenticated_scope ON deploy_targets
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

--> statement-breakpoint

------------------------------------------------------------------------
-- deploy_runs
------------------------------------------------------------------------
CREATE TABLE deploy_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id       uuid NOT NULL REFERENCES deploy_targets(id),
  actor_id        uuid NOT NULL REFERENCES actors(id),
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','running','succeeded','failed')),
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz NULL,
  page_count      integer NULL,
  file_count      integer NULL,
  error_message   text NULL,
  -- The site_snapshot id at deploy-start; lets us replay or audit a build
  -- against the exact state it captured. NULL until the generator picks one.
  site_snapshot_id uuid NULL REFERENCES site_snapshots(id) ON DELETE SET NULL
);

CREATE INDEX deploy_runs_target_idx ON deploy_runs (target_id, started_at DESC);
CREATE INDEX deploy_runs_status_idx ON deploy_runs (status, started_at DESC);

ALTER TABLE deploy_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE deploy_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deploy_runs_authenticated_scope ON deploy_runs;
CREATE POLICY deploy_runs_authenticated_scope ON deploy_runs
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

--> statement-breakpoint

------------------------------------------------------------------------
-- Seed: three default targets. Editor Publish goes to the default
-- (production) — staging exists so Ops users can promote-as-two-step.
-- Out dirs are relative to the repo root; the generator resolves them.
------------------------------------------------------------------------
INSERT INTO deploy_targets (name, env, out_dir, robots_default, is_default) VALUES
  ('dev',         'dev',         'output/dev',         'noindex', false),
  ('staging',     'staging',     'output/staging',     'noindex', false),
  ('production',  'production',  'output/production',  'index',   true)
ON CONFLICT (name) DO NOTHING;
