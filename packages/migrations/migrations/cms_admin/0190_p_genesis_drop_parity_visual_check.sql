-- SPDX-License-Identifier: MPL-2.0
--
-- 0190 — site-genesis skill: drop the `check_genesis_parity` pixel gate; verify
-- the materialisation with an AI VISUAL self-check instead.
--
-- `check_genesis_parity` was removed with the rest of the screenshot-diff
-- engine (a pixel diff grades "how close to the pixels", which false-fails a
-- faithful build and is brittle to any reflow). The chosen draft is still the
-- CONTRACT — the AI now RENDERS its built page (`screenshot_page`) and compares
-- it against the draft (`inspect_genesis_draft`, or the operator's uploaded
-- mockup for a byod_image draft) by looking, and reports honestly what differs.
--
-- Surgical replace()s on the 0110 body, idempotent by distinctive substring.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

-- S1 — the VERIFY step: visual self-check, no pixel gate.
UPDATE skills SET body = replace(body,
  $o$VERIFY the materialisation: after theme + pages + manifest, call `check_genesis_parity({pageId})`. The chosen draft is the CONTRACT — on warn/fail, fix the named gap (palette, section structure, spacing) and re-check; hard cap two repair rounds, then report the residual percentage honestly. Never tell the operator the design matches without a pass (or an explicit "parity unchecked" note when the screenshot runtime is unavailable).$o$,
  $n$VERIFY the materialisation VISUALLY: after theme + pages + manifest, RENDER the built page with `screenshot_page` and compare it against the chosen draft — `inspect_genesis_draft` gives the draft's exact palette + section outline (for a byod_image draft, the operator's uploaded mockup is the contract). The chosen draft is the CONTRACT — where the built page diverges (palette, section structure, spacing), fix the named gap and re-check; hard cap two repair rounds, then report honestly what still differs. There is NO automated pixel gate — your honest visual read IS the check, so never tell the operator the design matches when it does not.$n$
) WHERE slug = 'site-genesis';

-- S2 — the byod_image note: visual comparison, not the parity gate.
UPDATE skills SET body = replace(body,
  $o$and for byod_image the parity gate compares the built page against their original mockup, not against your reproduction.$o$,
  $n$and for byod_image you visually compare the built page (`screenshot_page`) against their original mockup, not against your reproduction.$n$
) WHERE slug = 'site-genesis';

COMMIT;
