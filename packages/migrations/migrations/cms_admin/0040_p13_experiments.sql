-- SPDX-License-Identifier: MPL-2.0
--
-- P13 — A/B experiments table.
--
-- Owner creates an experiment with a slug + page + 2-N variants. The
-- gateway's /api/variant.js script computes a stable visitor hash and
-- assigns a variant; analytics impressions roll into the existing log.
-- Promote-winner = standard P4 page-snapshot revert against the
-- chosen variant's snapshot (out of P13 scope; UI surfaces the
-- assignment counts only).

CREATE TABLE IF NOT EXISTS experiments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text NOT NULL UNIQUE,
  page_id         uuid NOT NULL REFERENCES pages(id),
  variants        jsonb NOT NULL,                 -- [{label, weight}, ...] with weight in 0..1
  status          text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'completed')),
  started_at      timestamptz NULL,
  completed_at    timestamptz NULL,
  winning_variant text NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid NULL REFERENCES actors(id)
);
CREATE INDEX IF NOT EXISTS experiments_status_idx ON experiments (status, created_at DESC);
CREATE INDEX IF NOT EXISTS experiments_page_idx ON experiments (page_id);

ALTER TABLE experiments ENABLE ROW LEVEL SECURITY;
ALTER TABLE experiments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS experiments_authenticated_scope ON experiments;
CREATE POLICY experiments_authenticated_scope ON experiments
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

-- Per-(experiment, variant, visitor) impression count. Append-only;
-- the gateway's /api/variant/assign endpoint UPSERTs +1 per call.
CREATE TABLE IF NOT EXISTS experiment_assignments (
  experiment_id   uuid NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  variant_label   text NOT NULL,
  visitor_id_hash text NOT NULL,
  impressions     int  NOT NULL DEFAULT 1,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (experiment_id, variant_label, visitor_id_hash)
);
CREATE INDEX IF NOT EXISTS experiment_assignments_variant_idx
  ON experiment_assignments (experiment_id, variant_label);

ALTER TABLE experiment_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE experiment_assignments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS experiment_assignments_authenticated_scope ON experiment_assignments;
CREATE POLICY experiment_assignments_authenticated_scope ON experiment_assignments
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);
