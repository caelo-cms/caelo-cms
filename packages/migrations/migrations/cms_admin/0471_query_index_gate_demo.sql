-- SPDX-License-Identifier: MPL-2.0
--
-- 0471 — issue #1293 acceptance demo, DELIBERATELY BAD and removed in the
-- next commit: a foreign key without an index. The FK index lint must fail.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS demo_page_id uuid REFERENCES pages (id);

COMMIT;
