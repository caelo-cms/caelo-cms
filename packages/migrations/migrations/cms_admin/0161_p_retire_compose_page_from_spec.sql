-- SPDX-License-Identifier: MPL-2.0
--
-- 0161 — retire `compose_page_from_spec` in favour of `build_page` (#299).
--
-- Root-cause cleanup (token/efficiency analysis, run-logs/token-efficiency-
-- analysis.md): we shipped THREE overlapping page-composition tools —
-- `compose_page_from_spec` (v0.6.0), `build_page` (#299), and
-- `add_module_to_page`. `compose_page_from_spec` is strictly inferior:
--   - its sections carry NO `fields[]`, so any `{{placeholder}}` in the HTML
--     fails module validation ("references undeclared field") — in a live
--     run ALL sections failed for exactly this reason;
--   - it is NOT transactional (a partial failure orphans the page) and NOT
--     idempotent (retry hits "page already exists").
-- `build_page` supersedes it on every axis (per-module `fields[]`, existing
-- OR new page, one transaction, content instances, same cold-start gate).
-- The tool + its schema are removed from the code; this migration updates
-- the four seeded skills that still name it so #301's allowlist validator
-- doesn't reject a now-unknown tool and the bodies stop teaching the wrong
-- call shape. Guarded + idempotent.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

-- 1) Allowlists: drop compose_page_from_spec, add build_page (dedup-safe).
UPDATE skills
SET allowlisted_tools =
  CASE
    WHEN (allowlisted_tools - 'compose_page_from_spec') @> '["build_page"]'::jsonb
      THEN (allowlisted_tools - 'compose_page_from_spec')
    ELSE (allowlisted_tools - 'compose_page_from_spec') || '["build_page"]'::jsonb
  END
WHERE allowlisted_tools @> '["compose_page_from_spec"]'::jsonb;

-- 2) compose-page body: rewrite the PREFERRED-path instruction to build_page's
--    real contract (page + modules[] with per-module semantic fields[]), and
--    steer AWAY from bare literal HTML (the extractor-fallback anti-pattern).
UPDATE skills
SET body = REPLACE(
  body,
  'PREFERRED for multi-section pages: call compose_page_from_spec once with {slug, name, title, sections:[{displayName, html, css?, js?}]}. The handler creates the page + creates and attaches each section as a module on the content block in one tx-like call. Saves N+1 round-trips vs. orchestrating create_page + add_module_to_page individually. Per-section failures are reported but the page is NOT rolled back.',
  'PREFERRED for multi-section pages: call build_page once with {page:{slug, title, name?}, modules:[{blockName, displayName, html, fields:[{name, kind, label}], content:{source:''inline'', values:{…}}}]}. One transaction — the page plus every section module lands together, and a partial failure rolls the WHOLE call back (no orphan page, safe to retry). Author {{field}} placeholders in html WITH a matching fields[] entry using semantic snake_case names; never bare literal HTML that leans on the extractor heuristic.'
)
WHERE slug = 'compose-page'
  AND body LIKE '%compose_page_from_spec once with {slug, name, title, sections%';

-- 3) site-genesis body: same tool swap, correct shape framing.
UPDATE skills
SET body = REPLACE(
  body,
  'build the page with `compose_page_from_spec`, re-expressing each draft section as a module whose CSS references the theme vars you just created.',
  'build the page with `build_page` (one call: the page plus every section module, each with its own semantic fields[]), whose module CSS references the theme vars you just created.'
)
WHERE slug = 'site-genesis'
  AND body LIKE '%build the page with `compose_page_from_spec`%';

-- 4) design-quality body: plain tool-name swap in the parenthetical list.
UPDATE skills
SET body = REPLACE(
  body,
  '(compose_page_from_spec, add_module_to_*, edit_module touching css/html)',
  '(build_page, add_module_to_*, edit_module touching css/html)'
)
WHERE slug = 'design-quality'
  AND body LIKE '%(compose_page_from_spec, add_module_to_*, edit_module touching css/html)%';

COMMIT;
