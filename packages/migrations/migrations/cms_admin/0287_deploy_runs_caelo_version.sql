-- SPDX-License-Identifier: MPL-2.0
--
-- 0287 — the Caelo version a build was rendered with (#834).
--
-- Publish live rebuilds the staged content with the live host and refuses
-- when the rebuild differs from the staged build's parity manifest (#650).
-- After a Caelo upgrade between Stage and Publish live, the new generator
-- can render the same content differently (e.g. #793 renamed the pinned
-- font files), and the refusal blamed site edits nobody made. Recording
-- the version next to the manifest lets the refusal name the real cause:
-- "Caelo was updated from X to Y since this Stage".
--
-- Expand-only: a nullable column. NULL means the run predates this
-- migration, so its version is unknown — the refusal says exactly that
-- instead of guessing. Inherits deploy_runs' existing RLS policies.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE deploy_runs
  ADD COLUMN IF NOT EXISTS caelo_version text;

COMMENT ON COLUMN deploy_runs.caelo_version IS
  'CAELO_VERSION of the admin whose generator rendered this run''s build; NULL = recorded before 0287 (unknown).';

COMMIT;
