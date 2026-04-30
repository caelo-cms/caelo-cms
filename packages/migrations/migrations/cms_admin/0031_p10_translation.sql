-- SPDX-License-Identifier: MPL-2.0
--
-- Phase 10 — AI translation (Mode 1 + Mode 2) + bulk dashboard +
-- glossary + style guide.
--
-- Per CMS_REQUIREMENTS §7.6:
--   Mode 1 = new translation (target locale has no row yet).
--   Mode 2 = update existing translation with structured diff.
-- Per §7.7: dashboard shows per-page × per-locale matrix; bulk
-- "Auto-translate everything stale" is a single Owner action.

------------------------------------------------------------------------
-- site_glossary — per-locale canonical translations of source terms
-- (e.g. proper nouns kept verbatim, brand-specific renderings).
-- Read by every Mode 1 + Mode 2 prompt as injected context so the AI
-- doesn't translate "Caelo" → "Cielo" or "CMS" → "GVS" inconsistently.
------------------------------------------------------------------------
CREATE TABLE site_glossary (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_term  text NOT NULL,
  locale       text NOT NULL REFERENCES locales(code),
  translation  text NOT NULL,
  context      text NULL,
  created_by   uuid REFERENCES actors(id),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_term, locale)
);
CREATE INDEX site_glossary_locale_idx ON site_glossary (locale);

ALTER TABLE site_glossary ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_glossary FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS site_glossary_authenticated_scope ON site_glossary;
CREATE POLICY site_glossary_authenticated_scope ON site_glossary
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

--> statement-breakpoint

------------------------------------------------------------------------
-- site_style_guide — one row per locale; freeform tone/voice/formality
-- markdown shown to the AI as Mode 1 / Mode 2 prompt context.
------------------------------------------------------------------------
CREATE TABLE site_style_guide (
  locale       text PRIMARY KEY REFERENCES locales(code),
  body         text NOT NULL CHECK (length(body) <= 4000),
  updated_by   uuid REFERENCES actors(id),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE site_style_guide ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_style_guide FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS site_style_guide_authenticated_scope ON site_style_guide;
CREATE POLICY site_style_guide_authenticated_scope ON site_style_guide
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

--> statement-breakpoint

------------------------------------------------------------------------
-- translation_jobs — bulk runs of "Auto-translate everything stale" /
-- per-locale / per-page-set translations. Synchronous translations
-- of single pages don't need a job row; they go through the chat-
-- runner directly.
--
-- The worker is in-process: a startup-time scan resets any
-- status='running' rows back to 'pending' (the previous worker
-- crashed mid-flight), then sequential unit dispatch resumes.
------------------------------------------------------------------------
CREATE TABLE translation_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  initiated_by    uuid NOT NULL REFERENCES actors(id),
  scope           jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'paused')),
  total_units     int NOT NULL DEFAULT 0,
  completed_units int NOT NULL DEFAULT 0,
  errored_units   int NOT NULL DEFAULT 0,
  cost_microcents bigint NOT NULL DEFAULT 0,
  cap_microcents  bigint NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz NULL,
  error_summary   text NULL,
  CONSTRAINT translation_jobs_total_nonneg CHECK (total_units >= 0),
  CONSTRAINT translation_jobs_progress_lte_total
    CHECK (completed_units + errored_units <= total_units)
);
CREATE INDEX translation_jobs_status_idx ON translation_jobs (status, created_at DESC);
CREATE INDEX translation_jobs_initiated_idx ON translation_jobs (initiated_by);

ALTER TABLE translation_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE translation_jobs FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS translation_jobs_authenticated_scope ON translation_jobs;
CREATE POLICY translation_jobs_authenticated_scope ON translation_jobs
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

--> statement-breakpoint

------------------------------------------------------------------------
-- translation_job_units — one row per (job, page, locale) unit. The
-- worker walks these sequentially, marking running → completed/errored.
-- Page-level snapshot lives in site_snapshots (existing P4 path);
-- this row is purely process metadata + per-unit cost.
------------------------------------------------------------------------
CREATE TABLE translation_job_units (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          uuid NOT NULL REFERENCES translation_jobs(id) ON DELETE CASCADE,
  page_id         uuid NOT NULL REFERENCES pages(id),
  target_locale   text NOT NULL REFERENCES locales(code),
  mode            text NOT NULL CHECK (mode IN ('mode_1', 'mode_2')),
  status          text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'errored', 'skipped')),
  variant_page_id uuid NULL REFERENCES pages(id),
  cost_microcents bigint NOT NULL DEFAULT 0,
  error_message   text NULL,
  started_at      timestamptz NULL,
  finished_at     timestamptz NULL,
  UNIQUE (job_id, page_id, target_locale)
);
CREATE INDEX translation_job_units_pending_idx
  ON translation_job_units (job_id, status) WHERE status = 'pending';
CREATE INDEX translation_job_units_job_idx ON translation_job_units (job_id);

ALTER TABLE translation_job_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE translation_job_units FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS translation_job_units_authenticated_scope ON translation_job_units;
CREATE POLICY translation_job_units_authenticated_scope ON translation_job_units
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);
