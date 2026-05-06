-- SPDX-License-Identifier: MPL-2.0
--
-- v0.2.18 / Fix D — comments long-term archive in cms_admin.
--
-- Approved comments are persisted here after moderation; the
-- corresponding cms_public row is deleted in the same transaction
-- pair, so the public DB only ever holds pending submissions + any
-- not-yet-archived approvals from the last few seconds. A future
-- compromise of cms_public leaks at most that small in-flight slice
-- — the long-term comment history stays in cms_admin.
--
-- The static-generator's plugin pass + the Web Component delta-fetch
-- both read approved comments from THIS table (via
-- comment_archive.list_for_page) instead of cms_public. This means
-- the cms_public.plugin_comments.comments table is now purely an
-- inbox — visitors write, moderators decide, archive promotes,
-- public row goes away.

CREATE TABLE IF NOT EXISTS comment_archive (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The cms_public row this archive entry was promoted from. Unique
  -- so the same approval can't double-insert (idempotency hook for
  -- crash-during-archive recovery).
  public_row_id   uuid NOT NULL UNIQUE,
  page_id         uuid NOT NULL,
  locale          text NOT NULL,
  parent_id       uuid NULL,
  author_name     text NOT NULL,
  content         text NOT NULL,
  status          text NOT NULL CHECK (status IN ('approved', 'rejected', 'spam')),
  submitted_at    timestamptz NOT NULL,
  archived_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS comment_archive_page_locale_status_idx
  ON comment_archive (page_id, locale, status, archived_at DESC);

ALTER TABLE comment_archive ENABLE ROW LEVEL SECURITY;
ALTER TABLE comment_archive FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS comment_archive_authenticated_scope ON comment_archive;
CREATE POLICY comment_archive_authenticated_scope ON comment_archive
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);
