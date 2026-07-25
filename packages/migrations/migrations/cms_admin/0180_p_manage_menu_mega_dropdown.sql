-- SPDX-License-Identifier: MPL-2.0
--
-- 0180 — manage-menu skill: how to represent a MEGA DROPDOWN.
--
-- Operator question (2026-07-22): a menu with a mega dropdown. A `nav-menu`
-- structured set stores arbitrary JSON, but the template engine
-- (`template-engine.ts`) is a Mustache subset whose `{{#field}}` iterates a
-- list ONE level deep — link-list elements are flat {label, href} pairs, and
-- there is NO nested-section iteration over sub-arrays within one set. So a
-- flat nav-menu set cannot RENDER columns-of-links / dropdown panels. The
-- intended representation is nested MODULES: a header module with a
-- `module-list` field of panel sub-modules, each with its own heading +
-- link-list (the render resolver walks nested module refs up to
-- MAX_RECURSION_DEPTH = 8). This teaches the skill that distinction so the AI
-- builds a mega menu with sub-modules instead of trying to iterate subsets of
-- one set. Surgical replace(), idempotent (guarded on the new marker); the
-- anchor is the skill's closing line.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

UPDATE skills
SET body = replace(
  body,
  $anchor$Keep labels short and consistent; match the site's existing capitalisation and voice.$anchor$,
  $new$6. MEGA DROPDOWNS / multi-level menus are NESTED MODULES, not one flat set. A `nav-menu` set renders FLAT: the template engine iterates a set ONE level deep ({label, href} per item), and it has NO nested iteration over sub-arrays — so a single set cannot represent columns-of-links, grouped panels, or a dropdown's sub-structure (encode the nesting inside one set's items and it still renders flat). For a mega menu, build a header module with a `module-list` FIELD of panel/column sub-modules, each carrying its own heading + a `link-list`; nest another module-list for a further level — the render resolver walks nested module refs up to 8 deep. The flat top bar can stay a `nav-menu` set (link-rewriting-aware, reused across pages); the dropdown panels live as the sub-modules the module-list renders. Rule of thumb: flat/simple nav → a nav-menu set; multi-column or nested dropdown → nested modules.

Keep labels short and consistent; match the site's existing capitalisation and voice.$new$
)
WHERE slug = 'manage-menu'
  AND body NOT LIKE '%MEGA DROPDOWNS / multi-level menus are NESTED MODULES%';

COMMIT;
