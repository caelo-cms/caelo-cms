-- SPDX-License-Identifier: MPL-2.0
--
-- 0115 — page-type clustering on import pages (issue #194, epic #186).
--
-- structural_signature — deterministic code-computed shape (path
--                        pattern + bucketed DOM counts); equal
--                        signatures = one page type. "home" for the
--                        crawl's source URL.
-- cluster_key          — the page's CURRENT cluster; initialised from
--                        the signature, re-assignable by the AI after
--                        the operator corrects a grouping in chat.
-- cluster_label        — AI-authored human name ("Blogartikel",
--                        "Produktseite"); NULL until labelled.
--
-- Per CLAUDE.md §1A this is where a migrated page's `kind` is born:
-- one confirmed cluster → one template (compose v2, #195).

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE import_pages ADD COLUMN structural_signature text NULL;
ALTER TABLE import_pages ADD COLUMN cluster_key text NULL;
ALTER TABLE import_pages ADD COLUMN cluster_label text NULL;

CREATE INDEX IF NOT EXISTS import_pages_cluster_idx ON import_pages (run_id, cluster_key);

-- site-migrate skill gains the PAGE TYPES step (guarded, 0107-0109
-- amendment pattern — operator edits win; re-runs no-op).
UPDATE skills
SET body = body || '

PAGE TYPES (after the crawl, before building beyond the homepage): call `list_import_page_clusters({runId})` — the crawler grouped every page by structural shape. Present the clusters in plain words ("45 Seiten sehen aus wie Blogartikel, 12 wie Produktseiten, 5 statische Seiten") and label each via `assign_import_page_cluster` with a clear German/English name the operator used. If the operator corrects a grouping ("die Team-Seite ist keine Produktseite"), re-assign those pages with the same tool. Get an explicit chat confirmation of the final type list — each confirmed type becomes ONE template when the site is built.'
WHERE slug = 'site-migrate'
  AND body NOT LIKE '%list_import_page_clusters%';

COMMIT;
