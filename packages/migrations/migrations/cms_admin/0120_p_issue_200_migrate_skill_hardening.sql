-- SPDX-License-Identifier: MPL-2.0
--
-- 0120 — site-migrate skill hardening from the #200 determinism runs.
--
-- Run 2/3: the AI hand-built pages instead of calling
-- compose_from_import, collapsing everything onto one template — the
-- exact failure mode compose v2 exists to prevent. Run 3/3: one
-- marathon turn hit the runner's max_loops cap before notes/report.
-- Both are guidance gaps, not code gaps; the skill now states the
-- build path as exclusive and mandates turn-splitting for large
-- migrations.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

UPDATE skills
SET body = body || '

BUILD PATH, NON-NEGOTIABLE: for keep-design migrations `compose_from_import` is the ONLY way to build the pages. Never create migrated pages by hand (create_page / compose_page_from_spec) — hand-building collapses every page onto one template and skips the css/chrome preservation and the redirects that compose does in one transaction. Cluster confirmation first, then ONE compose_from_import call.

PACE YOURSELF: a migration is MULTIPLE turns, not one marathon. Good split: (turn) clusters presented + confirmed → (turn) compose_from_import + record notes per page in batched add_import_page_notes calls → (turn) verification vs the stored screenshots → (turn) get_import_run_report + closing narration. If you feel a turn getting long, finish the current step, summarise in one sentence, and continue next turn — running into the loop cap mid-build loses the report.'
WHERE slug = 'site-migrate'
  AND body NOT LIKE '%BUILD PATH, NON-NEGOTIABLE%';

COMMIT;
