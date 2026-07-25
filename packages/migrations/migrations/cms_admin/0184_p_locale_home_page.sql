-- SPDX-License-Identifier: MPL-2.0
--
-- 0184 — explicit per-locale HOMEPAGE designation.
--
-- Before this, the site root was decided ONLY by a magic slug
-- (`i18n.ts` maps slug ""/`home`/`index` → the locale root `/`). There
-- was NO explicit "this page is the homepage" designation, so a
-- migration could build the homepage twice (slug `home` AND slug `en`)
-- and nothing flagged the duplicate. `home_page_id` makes the
-- designation a first-class, AI-settable fact (via pages.set_home_page):
-- ANY page can be the locale root, keeping its own slug, and the
-- resolver / duplicate-URL backstop treat it as `/`.
--
-- Additive + safe: nullable column, ON DELETE SET NULL so deleting the
-- designated page silently clears the pointer. Inherits the existing
-- `locales_authenticated_scope` RLS policy — no new policy needed.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE locales
  ADD COLUMN home_page_id uuid NULL REFERENCES pages(id) ON DELETE SET NULL;

COMMIT;
