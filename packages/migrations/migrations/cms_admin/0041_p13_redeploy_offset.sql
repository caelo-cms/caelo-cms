-- SPDX-License-Identifier: MPL-2.0
--
-- P13 audit re-pass — persist the auto-redeploy orchestrator's
-- watermark so a process restart doesn't drop publishable events
-- that fired during the downtime. Stored as a column on the existing
-- site_settings singleton.

ALTER TABLE site_settings
  ADD COLUMN IF NOT EXISTS auto_redeploy_last_seen_at timestamptz NOT NULL DEFAULT now();
