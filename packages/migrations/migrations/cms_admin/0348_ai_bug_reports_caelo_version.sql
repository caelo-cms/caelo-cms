-- SPDX-License-Identifier: MPL-2.0
--
-- 0348 — a bug report carries the Caelo version that FILED it (#1072).
--
-- The forwarding payload used to stamp the version the install runs when
-- the report is SENT. A report filed on 0.11 and sent after the upgrade to
-- 0.12 then arrived as a 0.12 report, and the bug intake reopened the
-- defect as a regression from the release that contains its fix.
--
--   ai_bug_reports.caelo_version — the release the install ran when
--   ai_bug_reports.create wrote the row. NULL only for rows filed before
--   this column existed: their version was never recorded, and the payload
--   forwards them as "unknown" instead of guessing.
--
-- Expand-only: a nullable column. Inherits ai_bug_reports' RLS policies.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE ai_bug_reports
  ADD COLUMN IF NOT EXISTS caelo_version text
    CHECK (caelo_version IS NULL OR length(caelo_version) BETWEEN 1 AND 64);

COMMIT;
