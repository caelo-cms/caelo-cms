-- SPDX-License-Identifier: MPL-2.0
--
-- Phase 6.7.4 — page-bound and template-bound chat sessions.
--
-- Two new nullable columns on `chat_sessions`:
--
--   * `page_id`     — when set, the chat is scoped to one page. The
--                     /edit surface filters its history dropdown by this
--                     column so editing the homepage doesn't leak the
--                     /about chat into the picker (and vice-versa).
--   * `template_id` — when set, the chat is scoped to a template. P6.7.5
--                     (deferred) lights up an overlay on the template
--                     editor; the column ships now to avoid a second
--                     migration later.
--
-- Both default NULL. Existing sessions stay unbound and remain
-- accessible from `/content/chat` (the legacy cross-site surface). ON
-- DELETE SET NULL on each FK so deleting a page or template doesn't
-- cascade-delete the user's chat history — the chat just becomes
-- unbound.

ALTER TABLE chat_sessions
  ADD COLUMN page_id     uuid NULL REFERENCES pages(id)     ON DELETE SET NULL,
  ADD COLUMN template_id uuid NULL REFERENCES templates(id) ON DELETE SET NULL;

CREATE INDEX chat_sessions_page_id_idx     ON chat_sessions (page_id)     WHERE page_id     IS NOT NULL;
CREATE INDEX chat_sessions_template_id_idx ON chat_sessions (template_id) WHERE template_id IS NOT NULL;
