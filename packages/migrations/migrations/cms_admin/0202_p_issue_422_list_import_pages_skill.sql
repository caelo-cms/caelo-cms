-- SPDX-License-Identifier: MPL-2.0
--
-- 0202 (issue #422) — site-migrate: poll the crawl via `list_import_pages`,
-- which also carries every page's importPageId.
--
-- History: 0150's flow said "check `imports.get`" — a Query API op the AI has
-- NO tool for, so the advice dead-ended (the #422 dogfood run had to fall
-- back to render-greps). 0187 (R8) rewrote the crawl-approval sentence and
-- dropped the dead reference, but named NO polling surface at all — the AI
-- was told to wait on a status it had no way to read. #422 ships the
-- `list_import_pages` tool; this migration points the polling step at it and
-- names the id contract, giving the 0197 "always pass importPageId to
-- build_page" rule a source for the id.
--
-- Surgical replace() on the current body, idempotent by distinctive substring
-- (0187-R8's sentence — the body's only "while status is" occurrence).

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

UPDATE skills SET body = replace(body,
  $o$message arrives after their click, and while status is `crawling` say so in one sentence and continue when it reaches `ready_for_review`.$o$,
  $n$message arrives after their click; then poll `list_import_pages({runId})` — while the run status is `crawling` say so in one sentence, and continue when it reaches `ready_for_review`. The same call lists every crawled page's `importPageId`: the id you pass to `get_import_page`, `build_page` (page.importPageId), `check_page_content_inventory`, and `add_import_page_notes`.$n$
) WHERE slug = 'site-migrate';

COMMIT;
