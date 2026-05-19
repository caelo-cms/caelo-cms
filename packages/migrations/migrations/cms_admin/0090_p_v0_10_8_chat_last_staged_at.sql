-- SPDX-License-Identifier: MPL-2.0
--
-- v0.10.8 — Track per-chat "last Stage" so the toolbar's pending-
-- changes pill reflects edits since the last merge, not the chat's
-- lifetime total. chat.publish stamps `published_at`;
-- chat.merge_to_main (re-stageable) stamps this column. The three
-- "what's pending on this branch?" reads (chat.branch_change_count,
-- chat.branch_edited_entities, chat.list_pending_changes) filter
-- snapshots created after this timestamp.
ALTER TABLE chat_sessions
  ADD COLUMN last_staged_at timestamptz NULL;
