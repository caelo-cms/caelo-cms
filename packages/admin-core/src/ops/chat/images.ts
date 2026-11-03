// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #359 — resolve an AI-produced chat image for the transcript view.
 *
 *   chat.get_message_image   the stored object (key + type) of one image
 *                            attachment on one message of a chat the caller
 *                            owns.
 *
 * Tool-produced images (screenshots, external captures) are persisted as
 * `chat_messages.attachments` entries pointing at an object under
 * `chat-images/` (#356). They are not media assets, so nothing in
 * `/_caelo/media` addresses them; the chat route that serves the bytes asks
 * this op which object a message references. The client names only
 * (session, message, attachment index) — never a storage key — so a URL
 * cannot be bent into a path, and the owner filter is the same one every
 * session read applies: another user's chat reads as not found.
 *
 * Only TOOL rows answer. The chat runner writes them, server-side, with the
 * key of the image the tool returned; a user row is written from client
 * input, so a key on one would let a caller who knows (or guesses) another
 * chat's content hash read that chat's capture through their own chat. The
 * stream endpoint refuses such user attachments at the boundary as well.
 */

import { defineOperation } from "@caelo-cms/query-api";
import {
  CHAT_IMAGE_MIMES,
  CHAT_MAX_ATTACHMENTS,
  err,
  isWellFormedChatImageKey,
  ok,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";

const NOT_FOUND =
  "chat image not found — the chat is not yours, the message has no stored image at that index, or the weekly chat-image sweep already removed it";

export const getChatMessageImageOp = defineOperation({
  name: "chat.get_message_image",
  readScope: "request",
  // Why human-only: it serves the operator's browser (the transcript's
  // images route) and nothing else. The AI already receives every image a
  // tool returns as part of that tool's result, so an AI tool for this op
  // would add a second, redundant path to the same bytes. The owner filter
  // below is the access rule, exactly as for chat.get_session.
  actorScope: ["human"],
  database: "cms_admin",
  input: z
    .object({
      chatSessionId: z.string().uuid(),
      messageId: z.string().uuid(),
      index: z
        .number()
        .int()
        .min(0)
        .max(CHAT_MAX_ATTACHMENTS - 1),
    })
    .strict(),
  output: z.object({
    storageKey: z.string(),
    mime: z.enum(CHAT_IMAGE_MIMES),
  }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT m.attachments
      FROM chat_messages m
      JOIN chat_sessions s ON s.id = m.chat_session_id
      WHERE m.id = ${input.messageId}::uuid
        AND m.chat_session_id = ${input.chatSessionId}::uuid
        AND m.role = 'tool'
        AND s.created_by = ${ctx.actorId}::uuid
      LIMIT 1
    `)) as unknown as { attachments: unknown }[];
    const attachments = rows[0]?.attachments;
    const att = Array.isArray(attachments) ? (attachments[input.index] as unknown) : undefined;
    const parsed = z
      .object({ storageKey: z.string(), mime: z.enum(CHAT_IMAGE_MIMES) })
      .safeParse(att);
    // An operator upload (assetId) is served by /_caelo/media; only a
    // well-formed chat-image key is answered here.
    if (!parsed.success || !isWellFormedChatImageKey(parsed.data.storageKey)) {
      return err({ kind: "HandlerError", operation: "chat.get_message_image", message: NOT_FOUND });
    }
    return ok({ storageKey: parsed.data.storageKey, mime: parsed.data.mime });
  },
});
