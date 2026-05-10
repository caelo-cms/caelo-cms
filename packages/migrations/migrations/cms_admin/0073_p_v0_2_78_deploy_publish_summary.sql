-- SPDX-License-Identifier: MPL-2.0

-- v0.2.78 — record per-publish summary on the deploy_runs row.
--
-- Stage / Confirm-publish now delegate to a per-provider
-- StaticPublisher adapter (see packages/admin-core/src/deploy/).
-- Each adapter returns a {provider, uploadedCount,
-- skippedUnchangedCount, location} summary that the Ops dashboard
-- renders inline with the run ("uploaded 84, skipped 19,916,
-- gs://bucket/_staging/<runId>/").
--
-- Without this column the summary would have to live in the existing
-- error_message text field (overloaded + lossy) or in a side table
-- (over-engineered for what's effectively per-row metadata).

ALTER TABLE deploy_runs
  ADD COLUMN IF NOT EXISTS publish_summary jsonb;
