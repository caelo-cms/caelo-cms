-- SPDX-License-Identifier: MPL-2.0
--
-- 0205 — locale-aware crawl scope + final-URL provenance (issue #425).
-- (Numbered 0205 by reservation: 0200-0204 are left for sibling PRs in
-- flight; the runner globs *.sql so gaps are harmless.)
--
-- Dogfood 2026-08-04: migrating the German searchviu site, the crawl
-- stored the EN sample URL of a blog article whose German version lives
-- at /google-search-console-daten-nach-bigquery-exportieren/ —
-- discovered only via a live redirect at rebuild time.
--
-- import_runs.crawl_scope — the operator's language/section scope
-- ({pathPrefix?, locale?}) the crawler enforces: out-of-scope URLs are
-- recorded as skipped, never crawled; hreflang alternates bridge to the
-- scope-locale version. NULL = unscoped (full-site crawl).
--
-- import_pages.requested_url — redirect provenance: the originally
-- requested URL when the fetch followed a same-host redirect.
-- source_url now stores the FINAL post-redirect URL (slugs + redirect
-- planning start from the page that actually exists); NULL = no
-- redirect (requested == final).

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE import_runs ADD COLUMN IF NOT EXISTS crawl_scope jsonb NULL;
ALTER TABLE import_pages ADD COLUMN IF NOT EXISTS requested_url text NULL;

COMMIT;
