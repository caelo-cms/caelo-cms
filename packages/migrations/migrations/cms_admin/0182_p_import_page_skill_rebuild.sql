-- SPDX-License-Identifier: MPL-2.0
--
-- 0182 — import-page skill: rebuild via build_page, drop compose_from_import.
--
-- The `compose_from_import` AI tool was removed (it raw-materialised the
-- crawler's page-builder markup into "Body (imported)" modules — the div-soup
-- the rebuild contract forbids). The single-page import skill still told the
-- model to compose; this rewrites its step 3 to the build_page path: read the
-- captured content with `get_import_page` (Markdown + tokens + a screenshot
-- handle, never raw HTML) and author the page fresh with `build_page`. Also
-- adds `get_import_page` to the skill's allowlist preload hint. Surgical
-- replace() + jsonb append, idempotent (guarded on the compose mention / the
-- element-absence).

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

-- Step 3: compose -> get_import_page + build_page.
UPDATE skills
SET body = replace(
  body,
  $old$3. Materialise after approval: once the run reads ready_for_review, compose_from_import turns the staged page into a draft page + modules (aggregating extracted theme tokens, creating/binding a template). If it reports "still crawling", that is expected timing — poll and call it again, do not treat it as an error.$old$,
  $new$3. Rebuild after approval: once the run reads ready_for_review, read the captured content with `get_import_page` (the GIST — Markdown + the crawled design tokens + a source-screenshot handle, NEVER the raw HTML; pull one specific structure from the returned pageRef with `query_page_html` if needed), then author the page fresh with `build_page` — semantic modules carrying ALL of the source content. NEVER drop the source's page-builder markup onto the page; rebuild from the Markdown + screenshot + tokens. If the run still reports crawling, that is expected timing — check again shortly.$new$
)
WHERE slug = 'import-page'
  AND body LIKE '%compose_from_import%';

-- Preload get_import_page for the skill (append if missing).
UPDATE skills
SET allowlisted_tools = allowlisted_tools || '["get_import_page"]'::jsonb
WHERE slug = 'import-page'
  AND NOT (allowlisted_tools ? 'get_import_page');

COMMIT;
