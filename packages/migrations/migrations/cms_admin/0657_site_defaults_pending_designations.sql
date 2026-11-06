-- SPDX-License-Identifier: MPL-2.0
--
-- 0657 — a designation of a page only a branch holds waits for that page.
--
-- `home_page_id` and `not_found_page_id` are global, but pages.set_home_page
-- and pages.set_not_found_page accept a page a chat just created, which main
-- does not have yet. Written straight into the pointer, that breaks main:
-- the static build refuses every other chat's Stage ("the designated 404 page
-- is not part of this build"), and the page's merge hits the current_path
-- unique index because the old home still holds "/". (Found by the #1158
-- audit.)
--
-- So the two pointers name main pages only. The pending_* columns hold a
-- designation whose page still lives on a branch: that branch reads it as
-- its designation (`loadSiteDesignations`), and the merge that takes the page
-- live moves it into the pointer. Full draft state for these settings stays
-- #1158. ON DELETE SET NULL as the pointers: a discarded branch's page clears
-- its pending designation. Inherits site_defaults' RLS policy.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE site_defaults
  ADD COLUMN IF NOT EXISTS pending_home_page_id uuid NULL REFERENCES pages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS pending_not_found_page_id uuid NULL REFERENCES pages(id) ON DELETE SET NULL;

-- A pointer already at a branch-only page moves over. main's root is the page
-- that serves "/" today, which the pointer should have stayed on.
UPDATE site_defaults sd
   SET pending_home_page_id = sd.home_page_id,
       home_page_id = (
         SELECT r.id FROM pages r
          WHERE r.current_path = '/' AND r.chat_branch_id IS NULL AND r.deleted_at IS NULL
       )
 WHERE sd.id = 1
   AND EXISTS (
     SELECT 1 FROM pages p WHERE p.id = sd.home_page_id AND p.chat_branch_id IS NOT NULL
   );

UPDATE site_defaults sd
   SET pending_not_found_page_id = sd.not_found_page_id,
       not_found_page_id = NULL
 WHERE sd.id = 1
   AND EXISTS (
     SELECT 1 FROM pages p WHERE p.id = sd.not_found_page_id AND p.chat_branch_id IS NOT NULL
   );

COMMIT;
