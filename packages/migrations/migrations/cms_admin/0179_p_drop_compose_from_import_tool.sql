-- SPDX-License-Identifier: MPL-2.0
--
-- 0179 — remove the `compose_from_import` AI tool from every skill allowlist.
--
-- Operator directive (2026-07-22): the migrate flow kept raw-materialising the
-- crawler's page-builder markup (Elementor "Body (imported)" modules) because
-- the AI still reached for `compose_from_import`. Removing it from the skill
-- PROSE (0178) was not enough — the tool was still in the catalogue, so the
-- model called it. The AI tool has now been unregistered in code
-- (ai/tools/index.ts); the underlying `imports.compose_from_run` op survives
-- ONLY for the human-driven ramp-up wizard. The migrate flow rebuilds every
-- page with `build_page` (fresh semantic HTML) — fidelity / media / inventory
-- resolve the source import_pages row by slug, no compose linkage needed.
--
-- This drops the now-dangling `compose_from_import` entry from the
-- `allowlisted_tools` preload hint on the skills that still list it
-- (site-migrate's own allowlist plus the import-page / workflow skills from
-- 0169 / 0172). A dangling entry is harmless at runtime (it never matches a
-- registered tool), but seed data must not name a tool that no longer exists.
-- The jsonb `-` operator removes the array element; the `?` guard makes the
-- UPDATE idempotent.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

UPDATE skills
SET allowlisted_tools = allowlisted_tools - 'compose_from_import'
WHERE allowlisted_tools ? 'compose_from_import';

COMMIT;
