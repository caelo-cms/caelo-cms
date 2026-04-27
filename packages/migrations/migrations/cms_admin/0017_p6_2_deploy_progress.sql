-- SPDX-License-Identifier: MPL-2.0
--
-- P6.2 — async deploys with progress tracking + content-addressed builds.
--   1. `progress` jsonb column. The Ops dashboard polls deploy_runs and
--      shows pagesDone / pagesTotal while a build is in flight; once the
--      build finishes the row flips to status='succeeded' or 'failed'.
--   2. `build_id` text column. The static generator now writes each
--      build into output/<env>/builds/<runId>/ and atomically swaps the
--      output/<env>/current symlink. `build_id` is the filename so a
--      deploy.rollback op can re-target the symlink at any prior build.

ALTER TABLE deploy_runs
  ADD COLUMN progress  jsonb NULL,
  ADD COLUMN build_id  text  NULL;
