-- SPDX-License-Identifier: MPL-2.0
--
-- 0197 — site-migrate: every crawled-page rebuild passes `importPageId`.
--
-- Dev-run failure: `check_page_content_inventory` returned "import page not
-- found" for a rebuilt sub-page. Root cause: the subagent built the page with
-- `build_page` WITHOUT `importPageId`, so no `accepted_page_id` link was
-- stamped on the `import_pages` row. `resolveImportPageRef` then had to
-- reverse-map the built page id by SLUG — which fails whenever the built slug
-- is translated (searchviu is German, the crawled `proposed_slug` differs). The
-- staging import_pages id always resolves, but the AI naturally passed the id
-- it just got back from `build_page`.
--
-- The tooling already supports the fix: passing `importPageId` to `build_page`
-- stamps `accepted_page_id = <built page id>` (slug-independent), which the
-- inventory check resolves on. The skill just never
-- told the AI to pass it. This migration makes it explicit at the three places
-- the AI decides: the per-page build contract, the subagent brief, and the
-- inventory gate.
--
-- Surgical replace()s on the current body, idempotent by distinctive substring.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

-- R1 — the "ONE build_page CALL PER PAGE" contract: always carry importPageId.
UPDATE skills SET body = replace(body,
  $o$existing via {pageId}) plus the FULL ordered module list$o$,
  $n$existing via {pageId}) ALWAYS carrying `importPageId` (the staging import_pages id of the crawled page you are rebuilding) so the build LINKS to the crawl (`accepted_page_id`) and is idempotent — the link is exactly what lets `check_page_content_inventory` resolve this page later EVEN when its built slug is translated; a rebuild without `importPageId` strands that check with "import page not found" — plus the FULL ordered module list$n$
) WHERE slug = 'site-migrate';

-- R2 — subagent brief: pass the import page id you already handed it.
UPDATE skills SET body = replace(body,
  $o$and build it with `build_page`, which page is the type's REPRESENTATIVE$o$,
  $n$and build it with `build_page` PASSING that import page id as `importPageId` (this links the build to the crawl and makes it idempotent, so the content-inventory check resolves regardless of a translated slug), which page is the type's REPRESENTATIVE$n$
) WHERE slug = 'site-migrate';

-- R3 — inventory gate: prefer the staging import id, which always resolves.
UPDATE skills SET body = replace(body,
  $o$run `check_page_content_inventory` (content completeness is the gate)$o$,
  $n$run `check_page_content_inventory` — pass the page's STAGING import_pages id, which ALWAYS resolves (a built page id only reverse-maps when its slug is untranslated) — (content completeness is the gate)$n$
) WHERE slug = 'site-migrate';

COMMIT;
