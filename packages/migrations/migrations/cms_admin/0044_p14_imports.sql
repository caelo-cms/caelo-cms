-- SPDX-License-Identifier: MPL-2.0
--
-- P14 — Site Import Wizard tables.
--
-- import_runs   — one row per crawl invocation. Status flow:
--                   proposed (AI suggested, awaiting Owner) →
--                   crawling (worker picked it up) →
--                   ready_for_review (crawl done; Owner reviews per-page) →
--                   completed (Owner ran cleanup_run) | failed (worker error)
-- import_pages  — one row per crawled URL inside a run. Each row stages
--                   a draft page record that can be promoted to a real
--                   `pages` row via imports.accept_page.

CREATE TABLE IF NOT EXISTS import_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_url      text NOT NULL,
  depth           int  NOT NULL DEFAULT 2 CHECK (depth BETWEEN 1 AND 5),
  max_pages       int  NOT NULL DEFAULT 50 CHECK (max_pages BETWEEN 1 AND 500),
  status          text NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'crawling', 'ready_for_review', 'completed', 'failed')),
  proposed_by     uuid NOT NULL REFERENCES actors(id),
  approved_by     uuid NULL REFERENCES actors(id),
  approved_at     timestamptz NULL,
  started_at      timestamptz NULL,
  finished_at     timestamptz NULL,
  pages_seen      int  NOT NULL DEFAULT 0,
  pages_extracted int  NOT NULL DEFAULT 0,
  error_message   text NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS import_runs_status_idx ON import_runs (status, created_at DESC);

ALTER TABLE import_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS import_runs_authenticated_scope ON import_runs;
CREATE POLICY import_runs_authenticated_scope ON import_runs
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

CREATE TABLE IF NOT EXISTS import_pages (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                uuid NOT NULL REFERENCES import_runs(id) ON DELETE CASCADE,
  source_url            text NOT NULL,
  proposed_slug         text NOT NULL,
  proposed_title        text NOT NULL DEFAULT '',
  -- Heuristic extraction: array of `{blockName, html}` records the
  -- crawler split out. Owner reviews + accepts to promote into real
  -- `modules` + `page_modules` rows.
  proposed_modules      jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Best-effort extracted theme tokens (color-primary, font-body, etc.).
  proposed_theme_tokens jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Object key in MinIO for the source-URL screenshot. NULL until the
  -- screenshot lands.
  screenshot_object_key text NULL,
  -- Diff against the post-deploy staged page; null until first diff.
  diff_status           text NULL CHECK (diff_status IN ('pass', 'warn', 'fail')),
  diff_pct              real NULL,
  -- When diff_status='fail' the Owner must acknowledge before
  -- production publish is allowed. Stamp once, audit-trail in audit_events.
  acknowledged_by       uuid NULL REFERENCES actors(id),
  acknowledged_at       timestamptz NULL,
  -- Once Owner clicks Accept, the staging page id lands here.
  accepted_page_id      uuid NULL REFERENCES pages(id) ON DELETE SET NULL,
  accepted_at           timestamptz NULL,
  rejected_at           timestamptz NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, source_url)
);

CREATE INDEX IF NOT EXISTS import_pages_run_idx ON import_pages (run_id, created_at DESC);

ALTER TABLE import_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_pages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS import_pages_authenticated_scope ON import_pages;
CREATE POLICY import_pages_authenticated_scope ON import_pages
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);
