-- SPDX-License-Identifier: MPL-2.0
--
-- P15 — provisioning outputs + A/B assignment aggregates.
--
-- provisioning_outputs is the snapshot of `pulumi stack output --json`
-- the cms-provision CLI's `pulumi-output-sync` subcommand persists
-- after every `pulumi up`. The admin's /security/dns page reads this
-- to render required DNS records + run resolver checks per row.
-- Single row per (provider, environment).
--
-- ab_assignment_aggregates is the materialised view the P12A
-- analytics plugin's per-provider log adapters fill from each
-- provider's native log sink (BigQuery / Athena / Log Analytics).
-- Same schema across providers so the Experiments dashboard query is
-- provider-agnostic.

CREATE TABLE IF NOT EXISTS provisioning_outputs (
  id              int  PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  provider        text NOT NULL CHECK (provider IN ('self-hosted','gcp','aws','azure')),
  environment     text NOT NULL CHECK (environment IN ('dev','staging','production')),
  outputs_json    jsonb NOT NULL,
  outputs_hash    text NOT NULL,
  synced_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provisioning_outputs_unique UNIQUE (provider, environment)
);

ALTER TABLE provisioning_outputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE provisioning_outputs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS provisioning_outputs_authed ON provisioning_outputs;
CREATE POLICY provisioning_outputs_authed ON provisioning_outputs
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (current_setting('caelo.actor_kind', true) = 'system');

CREATE TABLE IF NOT EXISTS ab_assignment_aggregates (
  experiment_id   uuid NOT NULL,
  variant_label   text NOT NULL,
  bucket_hour     timestamptz NOT NULL,
  impressions     bigint NOT NULL DEFAULT 0,
  conversions     bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (experiment_id, variant_label, bucket_hour)
);
CREATE INDEX IF NOT EXISTS ab_assignment_aggregates_recent_idx
  ON ab_assignment_aggregates (experiment_id, bucket_hour DESC);

ALTER TABLE ab_assignment_aggregates ENABLE ROW LEVEL SECURITY;
ALTER TABLE ab_assignment_aggregates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ab_assignment_aggregates_authed ON ab_assignment_aggregates;
CREATE POLICY ab_assignment_aggregates_authed ON ab_assignment_aggregates
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (current_setting('caelo.actor_kind', true) = 'system');
