// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #359 — the bytes of an AI-produced chat image (a tool's screenshot)
 * for the transcript, so a ScreenshotCard keeps its preview after a reload.
 * Owner-scoped like every session read: the key is resolved by
 * `chat.get_message_image` as the signed-in user, and another user's chat
 * reads as 404. GET only; the logic lives in `#lib/server/chat-image.ts`.
 */

import { getMediaStorage } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { chatImageResponse } from "#lib/server/chat-image.js";
import { requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, locals }) => {
  requirePermission(locals, "content.read");
  const { adapter, registry } = getQueryContext();
  return chatImageResponse(
    {
      resolve: async (address) => {
        const r = await execute(registry, adapter, locals.ctx, "chat.get_message_image", address);
        return r.ok ? (r.value as { storageKey: string; mime: string }) : null;
      },
      openStream: (key) => getMediaStorage().openStream(key),
    },
    params,
  );
};
