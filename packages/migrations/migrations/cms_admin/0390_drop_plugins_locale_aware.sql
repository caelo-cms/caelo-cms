-- SPDX-License-Identifier: MPL-2.0
--
-- 0390 — #748: drop the dead `plugins.locale_aware` column.
--
-- Added in 0047 for the core i18n of P11; core i18n moved into the
-- international-site plugin (epic #380, #385/#407/#409) and nothing has
-- read or written the column since. v0.11.0 does not reference it either
-- (it inserts plugin rows without it; the column default covered that),
-- so the previous image runs on this schema; the drop is still a
-- contract finding of the migration lint by its shape.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE plugins DROP COLUMN IF EXISTS locale_aware;

COMMIT;
