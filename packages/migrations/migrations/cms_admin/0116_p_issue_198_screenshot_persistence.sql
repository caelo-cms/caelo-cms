-- SPDX-License-Identifier: MPL-2.0
--
-- 0116 — persist import screenshots (issue #198, epic #186).
--
-- screenshot_object_key existed since 0044 but was never written: the
-- worker captured, diffed, and THREW AWAY the pixels — no surface
-- could show the original site, and the keep-design parity gate had
-- no stored reference. The worker now uploads both captures to media
-- storage; this adds the second column for the staged (rebuilt) side
-- so review surfaces render a true side-by-side.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE import_pages ADD COLUMN staged_screenshot_object_key text NULL;

COMMIT;
