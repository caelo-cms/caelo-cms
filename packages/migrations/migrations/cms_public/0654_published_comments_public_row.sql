-- SPDX-License-Identifier: MPL-2.0
--
-- 0654 — #1169: find a published comment by its public row id.
--
-- A reply's depth check walks its ancestors one by one on the gateway, a
-- visitor write, and a reply names its parent by the public row id. Without
-- this index each step reads every published comment of the page.
--
-- Not a contract migration: an added index, used by the release that ships
-- the read and ignored by the one before it.

CREATE INDEX IF NOT EXISTS published_comments_public_row_idx
  ON published_comments (public_row_id);
