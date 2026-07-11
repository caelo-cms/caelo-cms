-- SPDX-License-Identifier: MPL-2.0
--
-- 0111 — chat message attachments (issue #190, epic #186).
--
-- Operator-attached images on user messages. jsonb array of
-- { assetId, mime, alt } referencing media_assets rows — the media
-- pipeline owns the bytes; the message row records WHICH images ride
-- this turn so the chat-runner can attach them as provider image
-- parts and the transcript can render thumbnails after reload.
-- NULL = no attachments (every pre-#190 row).

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE chat_messages ADD COLUMN attachments jsonb NULL;

COMMIT;
