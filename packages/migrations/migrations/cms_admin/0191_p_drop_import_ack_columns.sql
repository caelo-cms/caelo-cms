-- SPDX-License-Identifier: MPL-2.0
--
-- 0191 — drop the import-page diff-acknowledgement columns.
--
-- `acknowledged_by` / `acknowledged_at` (0044) existed so an Owner could ack a
-- `diff_status='fail'` screenshot diff before the page could be accepted. The
-- screenshot-diff gate was removed (0188 dropped `diff_status`; the
-- `imports.acknowledge_page_diff` op is deleted), so nothing writes or reads
-- these columns anymore. Drop them.
--
-- Idempotent (IF EXISTS). No RLS impact — policies are per-table.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE import_pages
  DROP COLUMN IF EXISTS acknowledged_by,
  DROP COLUMN IF EXISTS acknowledged_at;

COMMIT;
