-- SPDX-License-Identifier: MPL-2.0
-- caelo:no-transaction
--
-- 0760 — issue #1676: the newest snapshots of one line (main, or one
-- branch), in order, without walking the others.
--
-- `pages.list_recently_edited` reads the newest snapshots main and the
-- caller's branch hold. Through `site_snapshots_created_at_idx` it walked
-- the newest snapshots of every branch and dropped the other branches'
-- ones: on main, where most snapshots belong to a branch (staged ones
-- keep theirs), and on an isolated branch beside a busy draft, that read
-- grew with the site's history. With this index each line is one ordered
-- range (`chat_branch_id IS NULL` is an index condition too), read newest
-- first with `id` as the tie-break of a keyset page.
--
-- site_snapshots grows with every write, so the index is built
-- CONCURRENTLY (#1291): dropped first, since an interrupted build leaves
-- an INVALID index behind that `IF NOT EXISTS` would keep.

DROP INDEX CONCURRENTLY IF EXISTS site_snapshots_branch_created_idx;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY site_snapshots_branch_created_idx
  ON site_snapshots (chat_branch_id, created_at DESC, id DESC);
