-- SPDX-License-Identifier: MPL-2.0
--
-- 0273 — issue #727 PR A: the quality check framework.
--
-- Lighthouse is no longer the only check of a Stage. Cheap findings checks
-- (registered in admin-core quality/checks/registry.ts; plugins contribute
-- more in a later PR) read every page of the staged build on EVERY Stage,
-- SEO-only Stages included, and report findings: rule id, severity
-- (error | warning | info), page (or none for a site-wide finding),
-- message, fix hint. Errors go through the same gate as Lighthouse
-- problems; warnings and info only inform.
--
--   quality_audit_pages.check_findings   every finding of the page's
--                                        checks, as measured (all
--                                        severities). The evaluated ones
--                                        join `problems` with kind
--                                        'check_rule'.
--   quality_audit_runs.checks            the findings checks of the run:
--                                        which ran, how many pages they
--                                        read, site-wide findings and
--                                        problems, check errors. NULL for
--                                        runs before this migration and
--                                        for runs that failed before the
--                                        checks ran.
--   quality_acceptances kind 'check'     the per-rule ratchet: an editor
--                                        accepts `accepted_count` error
--                                        findings of rule `audit_id` on a
--                                        page — or site-wide (page_id
--                                        NULL, only for this kind). A new
--                                        error beyond the count blocks
--                                        again; fewer measured errors
--                                        lower the count.
--
-- Expand-only (#696): new columns, a relaxed NOT NULL and a widened CHECK.
-- The previous image keeps reading and writing 'finding' / 'score' rows.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE quality_audit_pages
  ADD COLUMN check_findings jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE quality_audit_runs
  ADD COLUMN checks jsonb NULL;

ALTER TABLE quality_acceptances
  ADD COLUMN accepted_count integer NULL CHECK (accepted_count IS NULL OR accepted_count >= 1);

ALTER TABLE quality_acceptances DROP CONSTRAINT quality_acceptances_kind_check;
ALTER TABLE quality_acceptances
  ADD CONSTRAINT quality_acceptances_kind_check CHECK (kind IN ('finding', 'score', 'check'));

ALTER TABLE quality_acceptances DROP CONSTRAINT quality_acceptances_check;
ALTER TABLE quality_acceptances
  ADD CONSTRAINT quality_acceptances_check CHECK (
    (kind = 'finding' AND audit_id IS NOT NULL AND category IS NULL AND accepted_score IS NULL
       AND accepted_count IS NULL)
    OR (kind = 'score' AND audit_id IS NULL AND category IS NOT NULL AND accepted_score IS NOT NULL
       AND accepted_count IS NULL)
    OR (kind = 'check' AND audit_id IS NOT NULL AND category IS NULL AND accepted_score IS NULL
       AND accepted_count IS NOT NULL)
  );

-- A site-wide finding has no page; only check acceptances may be page-less.
ALTER TABLE quality_acceptances ALTER COLUMN page_id DROP NOT NULL;
ALTER TABLE quality_acceptances
  ADD CONSTRAINT quality_acceptances_page_shape CHECK (page_id IS NOT NULL OR kind = 'check');

-- One live acceptance per page + rule, and one per site-wide rule.
CREATE UNIQUE INDEX quality_acceptances_live_check_page_uniq
  ON quality_acceptances (page_id, audit_id)
  WHERE kind = 'check' AND revoked_at IS NULL AND page_id IS NOT NULL;
CREATE UNIQUE INDEX quality_acceptances_live_check_site_uniq
  ON quality_acceptances (audit_id)
  WHERE kind = 'check' AND revoked_at IS NULL AND page_id IS NULL;

-- The fix playbook learns the new findings: rule ids with a slash, a fix
-- hint naming the tool, and that a Stage re-checks every page. Targeted
-- replace() guarded by `body LIKE` on the exact old sentence (as 0256):
-- idempotent, and an Owner-edited body that no longer carries it stays.
UPDATE skills
   SET body = replace(
     body,
     '1. READ THE FINDINGS FIRST. Call `get_quality_audit` (no arguments = this chat''s newest check). Every problem names its page path and a Lighthouse audit id (`image-alt`, `color-contrast`, `meta-description`, …) or a category score below the page''s baseline. Fix by audit id, page by page. Never guess from the category name alone.',
     '1. READ THE FINDINGS FIRST. Call `get_quality_audit` (no arguments = this chat''s newest check). Every problem names its page path (or "site-wide") and either a Lighthouse audit id (`image-alt`, `color-contrast`, `meta-description`, …), a category score below the page''s baseline, or a page-check rule id (`<check>/<rule>`, e.g. `seo-check/title-missing` — rule ids contain a slash). Page-check problems carry a fix hint naming the tool to use: follow it, and fix every page of one rule in ONE bulk call. Page checks read EVERY page on every Stage, so a fix is re-checked by the next Stage even when only SEO texts changed. Warnings and hints never block; fix them only when the operator asks. Fix by audit or rule id, page by page. Never guess from the category name alone.'
   )
 WHERE slug = 'fix-quality-findings'
   AND body LIKE '%1. READ THE FINDINGS FIRST. Call `get_quality_audit` (no arguments = this chat''s newest check). Every problem names its page path and a Lighthouse audit id (`image-alt`, `color-contrast`, `meta-description`, …) or a category score below the page''s baseline. Fix by audit id, page by page. Never guess from the category name alone.%';

COMMIT;
