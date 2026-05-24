-- SPDX-License-Identifier: MPL-2.0
--
-- 0096 — Decision-support metadata for templates.
--
-- Per CLAUDE.md §1A: pages carry a `kind` derivable from their
-- template, so the AI sees three modules-on-product-pages as a
-- *pattern*, not a coincidence. Storing the kind on the template
-- (not on each page) lets one operator change re-classify every
-- product page by editing the template.
--
-- Kind values mirror the module taxonomy where it makes sense and
-- add page-specific values (home / blog / product / landing) the
-- module set doesn't have:
--
--   home        — the site's homepage; usually one per locale
--   landing     — campaign / marketing landing pages
--   product     — product detail pages on commerce-y sites
--   blog        — blog post + blog-index variants
--   doc         — docs / knowledge-base articles
--   content     — generic content page (default)
--   utility     — legal pages, contact, 404, etc.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE templates
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'content';

ALTER TABLE templates
  DROP CONSTRAINT IF EXISTS templates_kind_check;
ALTER TABLE templates
  ADD CONSTRAINT templates_kind_check
  CHECK (kind IN ('home', 'landing', 'product', 'blog', 'doc', 'content', 'utility'));

-- Best-effort backfill from slug. The operator can re-classify
-- explicitly via templates.update once the migration is in.
UPDATE templates
  SET kind = 'home'
  WHERE kind = 'content' AND (slug = 'home' OR slug LIKE '%home%' OR slug = 'index');

UPDATE templates
  SET kind = 'blog'
  WHERE kind = 'content' AND (slug LIKE '%blog%' OR slug LIKE '%post%' OR slug LIKE '%article%');

UPDATE templates
  SET kind = 'product'
  WHERE kind = 'content' AND (slug LIKE '%product%' OR slug LIKE '%shop%');

UPDATE templates
  SET kind = 'landing'
  WHERE kind = 'content' AND (slug LIKE '%landing%' OR slug LIKE '%campaign%');

UPDATE templates
  SET kind = 'doc'
  WHERE kind = 'content' AND (slug LIKE '%doc%' OR slug LIKE '%guide%' OR slug LIKE '%kb%');

COMMIT;
