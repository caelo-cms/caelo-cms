-- SPDX-License-Identifier: MPL-2.0
--
-- 0575 — a staging build's quality audit is planned before the build
-- (issue #1319).
--
-- A succeeded Stage must always have its audit row, and writing that row
-- must not be able to fail once the build is visible on staging (the
-- self-hosted publisher syncs `current/`, the cloud publishers select the
-- preview, before deploy.finish_trigger records the run). So
-- deploy.start_trigger, before anything is built, validates the Stage's
-- audit request and computes the whole audit row — classification,
-- Lighthouse target pages, fix round, who staged it — and stores it here.
-- deploy.finish_trigger then inserts exactly that row in the transaction
-- that marks the run succeeded: a plain insert of values already checked,
-- with nothing left to decide.
--
--   deploy_runs.planned_audit  the audit row a running staging build will
--     write when it succeeds. NULL for other targets, and cleared when the
--     run ends (written into quality_audit_runs on success, dropped by
--     deploy.fail_run on failure).
--
-- Expand-safe: a nullable column the previous release never reads.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE deploy_runs ADD COLUMN IF NOT EXISTS planned_audit jsonb NULL;

COMMIT;
