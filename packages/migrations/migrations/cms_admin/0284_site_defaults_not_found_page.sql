-- SPDX-License-Identifier: MPL-2.0
--
-- 0284 — explicit NOT-FOUND (404) page designation (#802).
--
-- Every static host Caelo deploys to answers an unknown URL from a
-- fixed `/404.html` (Firebase Hosting by convention, the GCS bucket's
-- `notFoundPage`, CloudFront's custom error response, Azure's
-- `error404Document`, Caddy's `handle_errors`), but nothing authored
-- that file: visitors got the host's generic error page, without the
-- site's design and — on Firebase — with a third-party font request.
--
-- `not_found_page_id` makes "this page is the site's 404 page" a
-- first-class, AI-settable fact (pages.set_not_found_page), mirroring
-- `home_page_id`. The static generator renders the designated page
-- through its normal template + layout and emits it as `/404.html`
-- (never at its own path), noindex and outside the sitemap.
--
-- Additive + safe: nullable column, ON DELETE SET NULL so a hard-deleted
-- page clears the pointer. Inherits site_defaults' existing RLS policy.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE site_defaults
  ADD COLUMN IF NOT EXISTS not_found_page_id uuid NULL REFERENCES pages(id) ON DELETE SET NULL;

COMMIT;
