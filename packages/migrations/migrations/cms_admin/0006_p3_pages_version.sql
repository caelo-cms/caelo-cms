-- SPDX-License-Identifier: MPL-2.0
--
-- Phase 3 follow-up: optimistic concurrency on `pages`.
--
-- Two editors saving the same page used to race to last-write-wins. Adding a
-- monotonically-incrementing `version` column lets pages.update and
-- pages.set_modules accept an `expected_version`, bump on success, and fail
-- with HandlerError("Conflict") when the value the client held is stale.
-- Snapshots in P4 will key off the same column so this is the right shape
-- to put in place now rather than later.

ALTER TABLE pages
  ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 0;
