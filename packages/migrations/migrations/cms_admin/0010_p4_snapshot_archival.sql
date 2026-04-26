-- SPDX-License-Identifier: MPL-2.0
--
-- P4 follow-up: archival hook on site_snapshots.
--
-- Snapshot tables grow unbounded — every content write adds a row. P12A
-- will land a real cron-driven archival policy; this migration just
-- prepares the schema so the policy is a no-op deployment, not a schema
-- change. Until P12A wires the cron, archived_at stays NULL and
-- snapshots.list ignores nothing.

ALTER TABLE site_snapshots
  ADD COLUMN IF NOT EXISTS archived_at timestamptz NULL;

CREATE INDEX IF NOT EXISTS site_snapshots_archived_at_idx
  ON site_snapshots (archived_at) WHERE archived_at IS NOT NULL;
