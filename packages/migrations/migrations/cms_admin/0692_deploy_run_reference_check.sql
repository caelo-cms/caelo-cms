-- SPDX-License-Identifier: MPL-2.0
--
-- 0692 — a staging build records its link check for its quality audit
-- (issue #1594).
--
-- deploy.start_trigger runs the reference check where every build starts.
-- A staging build scans the same read under the Publish policy too and
-- stores the result here; the Stage's quality audit reports it
-- (quality_audits.reference_check) instead of reading the whole site again
-- twice. The audit then judges the links of the state the build rendered.
--
--   deploy_runs.reference_check  the Publish-policy issues of the build's
--     link check (ops/content/link-integrity.ts recordedReferenceCheckSchema).
--     NULL for other targets and for a run staged before this release, and
--     cleared when a run fails (it has no audit).
--
-- Expand-safe: a nullable column the previous release never reads.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE deploy_runs ADD COLUMN IF NOT EXISTS reference_check jsonb NULL;

COMMIT;
