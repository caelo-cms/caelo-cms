-- SPDX-License-Identifier: MPL-2.0
--
-- 0234 — issue #553 quality gate: Lighthouse audits after a substantial
-- Stage, the per-page ratchet, and per-page accepted findings.
--
--   quality_audit_runs    one audit of one staging deploy run. A retry of a
--                         failed audit is a new row on the same deploy run.
--   quality_audit_pages   per audited page: category scores, failing
--                         Lighthouse audits, and the evaluated problems.
--   quality_baselines     the ratchet: per page + category, the score a
--                         drop is measured against (starts at 100).
--   quality_acceptances   findings / score drops an editor accepted, per
--                         page. Never applies to another page.
--
-- Every table is site-wide ops state, readable and writable by every
-- authenticated Query API actor (same policy shape as deploy_runs); which
-- actor may change what is decided by each op's actorScope.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE quality_audit_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deploy_run_id    uuid NOT NULL REFERENCES deploy_runs(id) ON DELETE CASCADE,
  -- The chat whose Stage produced the deploy; NULL for staging deploys
  -- outside a chat (Ops "Deploy staging", the pages list's Stage).
  chat_session_id  uuid NULL REFERENCES chat_sessions(id) ON DELETE SET NULL,
  requested_by     uuid NOT NULL REFERENCES actors(id),
  -- queued → running → passed | problems | errored; skipped when the
  -- Stage's changes cannot affect rendering (decided at enqueue time);
  -- superseded when a newer Stage replaced the build before it ran (the
  -- newer Stage's audit then covers its pages).
  status           text NOT NULL
                   CHECK (status IN ('queued','running','passed','problems','errored','skipped','superseded')),
  -- StageClassification: { auditNeeded, reasons[], skipped[] }.
  classification   jsonb NOT NULL,
  -- Ordered page ids to audit (homepage first), capped at enqueue time.
  target_page_ids  uuid[] NOT NULL DEFAULT '{}',
  performance_runs integer NOT NULL DEFAULT 3 CHECK (performance_runs BETWEEN 1 AND 5),
  -- The staging origin the pages were fetched from (set when running).
  base_url         text NULL,
  -- Loud infrastructure failure (browser, timeout, staging unreachable).
  error_code       text NULL,
  error_message    text NULL,
  -- Totals for list views; the detail lives in quality_audit_pages.
  problem_count    integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz NULL,
  finished_at      timestamptz NULL,
  CHECK ((status = 'errored') = (error_message IS NOT NULL))
);

CREATE INDEX quality_audit_runs_deploy_idx ON quality_audit_runs (deploy_run_id, created_at DESC);
CREATE INDEX quality_audit_runs_status_idx ON quality_audit_runs (status, created_at);
CREATE INDEX quality_audit_runs_chat_idx ON quality_audit_runs (chat_session_id, created_at DESC);

CREATE TABLE quality_audit_pages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_run_id     uuid NOT NULL REFERENCES quality_audit_runs(id) ON DELETE CASCADE,
  page_id          uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  url              text NOT NULL,
  status           text NOT NULL CHECK (status IN ('clean','problems','errored')),
  -- { performance, accessibility, "best-practices", seo } as 0..100.
  scores           jsonb NULL,
  -- Every Performance run's score (the median is scores.performance).
  performance_runs integer[] NOT NULL DEFAULT '{}',
  -- FailingAudit[] as measured.
  failing_audits   jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- QualityProblem[] after acceptances + ratchet.
  problems         jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- HeldBackSignal[]: Performance signals the noise guard held back.
  held_back        jsonb NOT NULL DEFAULT '[]'::jsonb,
  error_code       text NULL,
  error_message    text NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (audit_run_id, page_id),
  CHECK ((status = 'errored') = (error_message IS NOT NULL))
);

CREATE INDEX quality_audit_pages_page_idx ON quality_audit_pages (page_id, created_at DESC);

CREATE TABLE quality_baselines (
  page_id          uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  category         text NOT NULL
                   CHECK (category IN ('performance','accessibility','best-practices','seo')),
  baseline         integer NOT NULL CHECK (baseline BETWEEN 0 AND 100),
  -- Consecutive audits below the baseline (Performance noise guard).
  below_streak     integer NOT NULL DEFAULT 0 CHECK (below_streak >= 0),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by_run   uuid NULL REFERENCES quality_audit_runs(id) ON DELETE SET NULL,
  PRIMARY KEY (page_id, category)
);

CREATE TABLE quality_acceptances (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id          uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  -- 'finding': a failing Lighthouse audit id is accepted on this page.
  -- 'score':   a category score drop is accepted; accepted_score became
  --            the page's baseline for that category.
  kind             text NOT NULL CHECK (kind IN ('finding','score')),
  audit_id         text NULL,
  category         text NULL
                   CHECK (category IS NULL OR category IN ('performance','accessibility','best-practices','seo')),
  accepted_score   integer NULL CHECK (accepted_score IS NULL OR accepted_score BETWEEN 0 AND 100),
  reason           text NOT NULL CHECK (length(btrim(reason)) > 0),
  accepted_by      uuid NOT NULL REFERENCES actors(id),
  accepted_at      timestamptz NOT NULL DEFAULT now(),
  audit_run_id     uuid NULL REFERENCES quality_audit_runs(id) ON DELETE SET NULL,
  revoked_at       timestamptz NULL,
  revoked_by       uuid NULL REFERENCES actors(id),
  CHECK (
    (kind = 'finding' AND audit_id IS NOT NULL AND category IS NULL AND accepted_score IS NULL)
    OR (kind = 'score' AND audit_id IS NULL AND category IS NOT NULL AND accepted_score IS NOT NULL)
  ),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);

-- One live acceptance per page + finding / category.
CREATE UNIQUE INDEX quality_acceptances_live_finding_uniq
  ON quality_acceptances (page_id, audit_id) WHERE kind = 'finding' AND revoked_at IS NULL;
CREATE UNIQUE INDEX quality_acceptances_live_score_uniq
  ON quality_acceptances (page_id, category) WHERE kind = 'score' AND revoked_at IS NULL;

ALTER TABLE quality_audit_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality_audit_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY quality_audit_runs_authenticated_scope ON quality_audit_runs
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

ALTER TABLE quality_audit_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality_audit_pages FORCE ROW LEVEL SECURITY;
CREATE POLICY quality_audit_pages_authenticated_scope ON quality_audit_pages
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

ALTER TABLE quality_baselines ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality_baselines FORCE ROW LEVEL SECURITY;
CREATE POLICY quality_baselines_authenticated_scope ON quality_baselines
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

ALTER TABLE quality_acceptances ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality_acceptances FORCE ROW LEVEL SECURITY;
CREATE POLICY quality_acceptances_authenticated_scope ON quality_acceptances
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

COMMIT;
