-- SPDX-License-Identifier: MPL-2.0
-- caelo:no-transaction
--
-- 0705 — the Publish live review lists the changes it ships.
--
-- A Stage stamps every snapshot header it merged with `staged_at` (the
-- merge time, chat.finalize_draft_stage / chat.finalize_stage). What
-- Publish live puts live beyond the live build is what was staged between
-- the two builds: headers with `staged_at` in [the live build's start,
-- the staged build's start) — `deploy.publish_preview` reads that window
-- for the pages and site-wide parts whose content changed.
--
-- site_snapshots grows with every write, so the index is built
-- CONCURRENTLY: a plain CREATE INDEX holds a SHARE lock for the whole
-- build and would stall every write of the running admin during the
-- upgrade. That cannot run in a transaction, so this file runs outside
-- one (`caelo:no-transaction`, runner.ts), one statement per breakpoint;
-- the index is dropped first, because an interrupted CONCURRENTLY build
-- leaves an INVALID index that `IF NOT EXISTS` would keep (as in 0463).
--
-- Partial: pending headers (`staged_at IS NULL`) are most of a busy draft
-- and never in the window.
--
-- Expand-only: an index the previous release does not use.

DROP INDEX CONCURRENTLY IF EXISTS site_snapshots_staged_at_idx;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY site_snapshots_staged_at_idx
  ON site_snapshots (staged_at)
  WHERE staged_at IS NOT NULL;
