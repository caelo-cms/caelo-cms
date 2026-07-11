-- SPDX-License-Identifier: MPL-2.0
--
-- 0118 — migration report (issue #197, epic #186).
--
-- import_pages.notes — jsonb array of AI-recorded findings made while
-- rebuilding: {category, note, applied}. Categories are typed at the
-- op boundary (typo | dead_link | missing_alt | thin_content |
-- improvement). `applied` distinguishes "we fixed this" (obvious typo)
-- from "you should look at this" (judgment call) — the skill draws
-- that line, the report renders it.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE import_pages ADD COLUMN notes jsonb NULL;

-- site-migrate skill: the REPORT closing step (guarded amendment).
UPDATE skills
SET body = body || '

NOTES + REPORT: while rebuilding pages, record what you noticed via `add_import_page_notes` — typos (fix obvious ones and mark applied: true), dead links, missing image alt texts, thin content, improvement ideas (applied: false — those are the operator''s call). Batch notes per page in one call. When the migration is done, fetch `get_import_run_report` and CLOSE with it in plain words: pages built per type, redirects created, what you fixed, what they should look at — the migration should end with "wir haben es besser gemacht", not just "wir haben kopiert".'
WHERE slug = 'site-migrate'
  AND body NOT LIKE '%get_import_run_report%';

COMMIT;
