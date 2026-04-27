-- SPDX-License-Identifier: MPL-2.0
--
-- Phase 6.7 — live-edit overlay schema.
--
-- Two additions:
--
--   1. `user_preferences` — per-user jsonb key/value store. The live-edit
--      overlay persists its layout (floating / pinned-bottom / pinned-right
--      / collapsed + position + size) here. **First per-user RLS policy
--      in the codebase** — existing tables scope by `caelo.actor_kind`,
--      this one scopes by `caelo.actor_id` because each user can only
--      see / mutate their own row. Sets a precedent for future per-user
--      state (notifications, onboarding flags, command-palette pins).
--
--   2. `chat_sessions.pinned_elements` — jsonb array of pinned chips
--      (`[{moduleId, selector, label}, ...]`). The live-edit overlay's
--      "lock" affordance moves a chip into this list so subsequent sends
--      automatically scope the AI to the same elements without the user
--      re-clicking. Default empty array; backwards-compatible with every
--      existing chat session.

------------------------------------------------------------------------
-- user_preferences
------------------------------------------------------------------------
CREATE TABLE user_preferences (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        text NOT NULL,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_preferences FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_preferences_self ON user_preferences;
CREATE POLICY user_preferences_self ON user_preferences
  USING (user_id = NULLIF(current_setting('caelo.actor_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('caelo.actor_id', true), '')::uuid);

--> statement-breakpoint

------------------------------------------------------------------------
-- chat_sessions.pinned_elements
------------------------------------------------------------------------
ALTER TABLE chat_sessions
  ADD COLUMN pinned_elements jsonb NOT NULL DEFAULT '[]'::jsonb;
