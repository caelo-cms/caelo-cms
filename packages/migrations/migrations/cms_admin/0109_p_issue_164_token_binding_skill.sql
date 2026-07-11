-- SPDX-License-Identifier: MPL-2.0
--
-- 0109 — teach the site-genesis materialise step the mechanical token
-- binding (issue #164 slice 2). Guarded append like 0106/0107:
-- operator-edited skills win; re-runs are no-ops.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

UPDATE skills
SET body = body || '

When building modules from the selected draft, pass `bindThemeLiterals: true` on `add_module_to_page` / `edit_module`: color and gradient literals that equal the theme''s token values are rewritten to `var(--…)` mechanically (the tool result lists every rewrite). Only translate by hand what the binder reports as unbound.'
WHERE slug = 'site-genesis'
  AND body NOT LIKE '%bindThemeLiterals%';

COMMIT;
