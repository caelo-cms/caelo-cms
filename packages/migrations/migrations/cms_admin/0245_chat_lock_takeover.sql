-- SPDX-License-Identifier: MPL-2.0
--
-- 0245 — issue #620 Part C: chat locks are TAKEN OVER instead of blocking.
--
-- When a chat writes an entity another chat holds with unstaged changes,
-- the writing chat adopts that pending change: the holder's branch
-- snapshots of the entity move to the writer's branch (under new
-- `chat.adopt_change` snapshot headers) and the lock moves with them.
-- Nothing is lost (the change now ships with the adopting chat) and
-- nothing is silently overwritten (the write builds on the adopted
-- state). There is deliberately NO time-based lock expiry: an expired
-- lock over unstaged changes would let two branches edit the same entity
-- and the next Stage would silently overwrite one of them.
--
-- 1. `site_snapshots.op_kind` gains 'chat.adopt_change'.
-- 2. `chat_lock_takeovers` records every takeover. It is the source of
--    the visible notices: the next tool result of the adopting chat AND
--    of the chat that lost the entity carries a one-line note (each side
--    is delivered once, `*_notified_at`), and the Open changes overview
--    lists recent takeovers per chat.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE site_snapshots DROP CONSTRAINT IF EXISTS site_snapshots_op_kind_check;
ALTER TABLE site_snapshots
  ADD CONSTRAINT site_snapshots_op_kind_check CHECK (op_kind IN (
    'modules.create',
    'modules.update',
    'modules.delete',
    'templates.create',
    'templates.update',
    'templates.delete',
    'template_blocks.set',
    'pages.create',
    'pages.update',
    'pages.set_modules',
    'pages.delete',
    'snapshots.revert_site',
    'snapshots.revert_module',
    'snapshots.revert_template',
    'snapshots.revert_page',
    'chat.publish',
    'chat.merge_to_main',
    'chat.stage',
    'chat.unstage',
    'layout_modules.set',
    'page_module_content.set',
    'structured_sets.set',
    'redirects.create',
    'redirects.update',
    'redirects.delete',
    'content_instances.create',
    'content_instances.set_values',
    'content_instances.delete',
    'placement.set_content',
    'placement.fork_content',
    'unknown',
    'themes.update_tokens',
    'themes.set_asset',
    'themes.duplicate',
    'themes.import_dtcg',
    'themes.import',
    'themes.activate',
    'themes.update_meta',
    'plugin_storage.insert',
    'plugin_storage.update',
    'plugin_storage.delete',
    'chat.discard_branch',
    'chat.adopt_change'
  ));

CREATE TABLE chat_lock_takeovers (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_kind            text NOT NULL,
  entity_id              uuid NOT NULL,
  -- Human label of the entity at takeover time (slug / title / name).
  label                  text NOT NULL,
  -- The chat that held the entity. SET NULL keeps the record readable
  -- after that chat is deleted; the title column keeps it nameable.
  from_chat_session_id   uuid NULL REFERENCES chat_sessions(id) ON DELETE SET NULL,
  from_chat_title        text NOT NULL,
  to_chat_session_id     uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  to_chat_title          text NOT NULL,
  -- Entity snapshots moved from the holder's branch (0 = the holder had
  -- nothing unstaged on it; only the lock moved).
  adopted_snapshot_count integer NOT NULL CHECK (adopted_snapshot_count >= 0),
  actor_id               uuid NOT NULL REFERENCES actors(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  to_notified_at         timestamptz NULL,
  from_notified_at       timestamptz NULL
);

CREATE INDEX chat_lock_takeovers_to_pending_idx
  ON chat_lock_takeovers (to_chat_session_id) WHERE to_notified_at IS NULL;
CREATE INDEX chat_lock_takeovers_from_pending_idx
  ON chat_lock_takeovers (from_chat_session_id) WHERE from_notified_at IS NULL;
CREATE INDEX chat_lock_takeovers_created_idx ON chat_lock_takeovers (created_at DESC);

ALTER TABLE chat_lock_takeovers ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_lock_takeovers FORCE ROW LEVEL SECURITY;
CREATE POLICY chat_lock_takeovers_authenticated_scope ON chat_lock_takeovers
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);

COMMIT;
