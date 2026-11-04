-- SPDX-License-Identifier: MPL-2.0
--
-- 0596 — indexes for paging pages.list and content_instances.list and
-- for reading a subtree (issue #1269, epic #1392).
--
-- `pages.list` and `content_instances.list` return rows oldest first and
-- continue after the last one they returned (`(created_at, id) > cursor`);
-- without an index on that order every row of the site is sorted to
-- return the first 50. A
-- subtree (`underPageId`) is read one tree level at a time from the
-- parent index (pages_parent_page_id_idx) and, on a chat's branch, from
-- the pending pages whose head names a parent of the level (a page the
-- chat moved in): that lookup gets its own partial index on the draft
-- head, so it reads the moved pages, not every pending page.
--
-- A path lookup on a branch (`pages.list({ paths })`) also finds the
-- pages a pending rename or move gave that path: a composed path ends in
-- the page's own slug, so it looks the last segment up among the pages'
-- slugs and the draft head's pending slugs.
--
-- Expand-only: five indexes.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE INDEX pages_created_id_idx ON pages (created_at, id);
CREATE INDEX content_instances_created_id_idx ON content_instances (created_at, id);

CREATE INDEX pages_slug_idx ON pages (slug) WHERE deleted_at IS NULL;
CREATE INDEX draft_pending_entities_page_slug_idx ON draft_pending_entities
  (chat_branch_id, slug) WHERE entity_kind = 'page';

CREATE INDEX draft_pending_entities_page_parent_idx ON draft_pending_entities
  (chat_branch_id, parent_page_id) WHERE entity_kind = 'page' AND parent_page_id IS NOT NULL;

COMMIT;
