-- SPDX-License-Identifier: MPL-2.0
--
-- 0107 — point the site-genesis skill's materialise step at the new
-- `inspect_genesis_draft` fact base (issue #164 compiler stage 1).
--
-- Guarded like the 0106 compose-page amendment: only rewrites the
-- 0105-seeded sentence when it is still present and the tool isn't
-- referenced yet — operator-edited skills win; re-runs are no-ops.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

UPDATE skills
SET body = replace(
  body,
  '7. MATERIALISE — until the design compiler ships (#164), translate the SELECTED draft by hand, in this order:',
  '7. MATERIALISE — start from facts, not eyeballing: call `inspect_genesis_draft` (defaults to the selected draft) for the exact palette with usage counts, gradients, typefaces, spacing histogram, and section outline; fetch the markup with `includeHtml: true` only when building the modules. Then, in this order:'
)
WHERE slug = 'site-genesis'
  AND body LIKE '%translate the SELECTED draft by hand%'
  AND body NOT LIKE '%inspect_genesis_draft%';

COMMIT;
