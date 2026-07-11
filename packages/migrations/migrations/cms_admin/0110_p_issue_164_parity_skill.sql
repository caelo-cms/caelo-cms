-- SPDX-License-Identifier: MPL-2.0
--
-- 0110 — wire the screenshot-parity gate into the site-genesis
-- materialise flow (issue #164 slice 3). Guarded append like
-- 0106/0107/0109: operator-edited skills win; re-runs are no-ops.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

UPDATE skills
SET body = body || '

VERIFY the materialisation: after theme + pages + manifest, call `check_genesis_parity({pageId})`. The chosen draft is the CONTRACT — on warn/fail, fix the named gap (palette, section structure, spacing) and re-check; hard cap two repair rounds, then report the residual percentage honestly. Never tell the operator the design matches without a pass (or an explicit "parity unchecked" note when the screenshot runtime is unavailable).'
WHERE slug = 'site-genesis'
  AND body NOT LIKE '%check_genesis_parity%';

COMMIT;
