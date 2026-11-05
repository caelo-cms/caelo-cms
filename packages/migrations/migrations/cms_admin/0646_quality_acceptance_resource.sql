-- SPDX-License-Identifier: MPL-2.0
--
-- 0646 — issue #1446: an accepted Lighthouse audit can hold for a file Caelo
-- or a plugin ships, on every page that loads it.
--
-- An acceptance belonged to a page, and each Stage audits other pages, so
-- Publish live stopped again for a file the operator had already decided on.
--
--   quality_acceptances.resource_path   the site path of a content-hashed
--                                        shipped file. Such a row is a
--                                        'finding' without a page: it covers
--                                        that audit for that file everywhere.
--                                        The hash in the path ends it when
--                                        the file changes.
--
-- The fix playbook learns the same: a targeted replace() guarded by `body
-- LIKE` on the exact old sentence (as 0256), so an Owner-edited body stays.
--
-- Expand-only (#696): a new nullable column and widened CHECKs. The previous
-- image reads only 'check' rows without a page, so it ignores the new rows.

BEGIN;

ALTER TABLE quality_acceptances ADD COLUMN resource_path text NULL;

-- A page-less row is a site-wide check rule or a finding for a shipped file.
ALTER TABLE quality_acceptances DROP CONSTRAINT quality_acceptances_page_shape;
ALTER TABLE quality_acceptances
  ADD CONSTRAINT quality_acceptances_page_shape CHECK (
    page_id IS NOT NULL OR kind = 'check' OR resource_path IS NOT NULL
  );

-- The accepted value is what "a worse value blocks again" compares with, so
-- a shipped file's acceptance always has one.
ALTER TABLE quality_acceptances
  ADD CONSTRAINT quality_acceptances_resource_shape CHECK (
    resource_path IS NULL
    OR (kind = 'finding' AND page_id IS NULL AND accepted_score IS NOT NULL
        AND length(resource_path) > 0)
  );

-- One live acceptance per audit + file.
CREATE UNIQUE INDEX quality_acceptances_live_resource_uniq
  ON quality_acceptances (audit_id, resource_path)
  WHERE kind = 'finding' AND revoked_at IS NULL AND resource_path IS NOT NULL;

UPDATE skills
   SET body = replace(
     body,
     'a worse value blocks again. It applies only to its pages. Check `list_quality_acceptances` first',
     'a worse value blocks again. It applies only to its pages, except that a finding naming only files Caelo or a plugin ships (`/_caelo/plugin/…`) is accepted for that check and file on every page loading it, until the file changes. Check `list_quality_acceptances` first'
   )
 WHERE slug = 'fix-quality-findings'
   AND body LIKE '%a worse value blocks again. It applies only to its pages. Check `list_quality_acceptances` first%';

COMMIT;
