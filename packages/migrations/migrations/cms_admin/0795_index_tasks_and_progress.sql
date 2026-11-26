-- SPDX-License-Identifier: MPL-2.0
--
-- 0795 — the search index at scale: a reporting job's attempt may run
-- several tasks, and a running index build reports how far it is.
--
-- reporting_jobs.tasks: how many tasks the job's attempts run (Cloud Run
-- `taskCount`). The index job asks for more when a build has more passages
-- to embed than one task embeds in a few minutes (a first index with
-- vectors, a model change: about 800,000 passages on a 50,000-page site);
-- the admin then starts the next attempt with that many
-- (admin-core reporting-jobs/launcher.ts). It never shrinks within one
-- piece of work, so a retry runs as wide as the attempt it replaces.
--
-- collection_releases.progress: the embedding progress of a pending
-- release, by task: { "tasks": { "<index>": { "embedded", "toEmbed" } },
-- "startedAt", "at" }. get_stage_status, the Publish live gate and the
-- admin's Stage menu say from it how far the index is and about how long
-- Publish live still waits.
--
-- Expand only: a server of the previous release writes neither column and
-- reads tasks as 1.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE reporting_jobs
  ADD COLUMN IF NOT EXISTS tasks integer NOT NULL DEFAULT 1 CHECK (tasks BETWEEN 1 AND 64);

ALTER TABLE collection_releases
  ADD COLUMN IF NOT EXISTS progress jsonb NULL
    CHECK (progress IS NULL OR jsonb_typeof(progress) = 'object');

COMMIT;
