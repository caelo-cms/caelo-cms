-- SPDX-License-Identifier: MPL-2.0
--
-- 0264 — page identity is the page id; the URL PATH is what must be
-- unique (epic #690, part 2).
--
-- With nested pages (0263) a slug is one path segment, so the same slug
-- can legitimately name several pages: /monitoring/alerts and
-- /rankings/alerts, or /about and /de/about. The site-wide slug index
-- from 0201 forbade that. Uniqueness now rests on the materialized,
-- composed path alone — pages_current_path_branch_uidx (0211), same
-- branch-aware shape — and the write ops refuse a would-be clash in the
-- caller's branch view before anything is written (page-move-plan.ts).

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

DROP INDEX IF EXISTS pages_slug_branch_uidx;

COMMIT;
