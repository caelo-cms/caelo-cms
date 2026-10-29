-- SPDX-License-Identifier: MPL-2.0
--
-- 0402 — Publish live and the plugin-data build hold no database
-- transaction while they build and upload (#1225, #1220).
--
-- Until now both ran their rebuild / bake and the provider upload inside one
-- transaction, and ordered every write to the live site by the transaction-
-- scoped advisory lock `caelo:static-live-release`: a pooled connection sat
-- `idle in transaction` for the whole Publish live while its own progress
-- writes took more from the same pool (the deadlock class of #1209). With a
-- short transaction per step that lock becomes a lease row, like the
-- staging-publication lease of 0393:
--
--   deploy_leases 'live-release' — which run is releasing a new version on
--     the live channel right now. Publish live and the plugin-data build
--     hold it from before their provider release until their run is
--     recorded; rollback, the redirect sync and the Firebase CDN purge lock
--     the row inside their (short) transaction while no run holds it.
--
--   claimed_by_run_id / claimed_at on deploy_pending_actions and
--   quality_pending_actions — an approved card applies its Publish live
--   outside any transaction now, so the row can no longer stay locked for
--   the whole apply. The claim marks it as being applied: a second click on
--   the same card (another tab, a retried request) is refused instead of
--   publishing twice. The status CHECK is unchanged; a claim whose run ended
--   or never started is released, so a failed apply stays retryable.
--
-- Expand-only: a wider CHECK, a new row, two nullable columns per table.
-- The previous release never reads any of them; during a rolling update this
-- release also honours the previous release's advisory lock (admin-core
-- deploy/live-release-lock.ts).

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE deploy_leases DROP CONSTRAINT IF EXISTS deploy_leases_name_check;
ALTER TABLE deploy_leases
  ADD CONSTRAINT deploy_leases_name_check CHECK (name IN ('staging-publication', 'live-release'));

INSERT INTO deploy_leases (name) VALUES ('live-release') ON CONFLICT (name) DO NOTHING;

-- No foreign key: the claim is written before the run row exists (the run
-- id is minted by the approval and handed to Publish live).
ALTER TABLE deploy_pending_actions ADD COLUMN IF NOT EXISTS claimed_by_run_id uuid;
ALTER TABLE deploy_pending_actions ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
ALTER TABLE quality_pending_actions ADD COLUMN IF NOT EXISTS claimed_by_run_id uuid;
ALTER TABLE quality_pending_actions ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

COMMIT;
