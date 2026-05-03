// SPDX-License-Identifier: MPL-2.0

/**
 * Pinned-elements write endpoint for the live-edit overlay. POST
 * `{chatSessionId, pinnedElements}` — replaces the session's
 * `chat_sessions.pinned_elements` jsonb. CSRF via `x-csrf-token`
 * header (body is JSON, P5 convention). Pinning is a human UI
 * affordance; the op rejects AI actors at the Validator.
 */

import { verifyCsrfToken } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { error, json } from "@sveltejs/kit";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { RequestHandler } from "./$types";

interface PinnedElementInput {
  moduleId: string;
  selector: string;
  label: string;
}

export const POST: RequestHandler = async ({ request, locals }) => {
  requirePermission(locals, "content.write");
  if (!locals.user) throw error(401, "Not authenticated");
  const csrf = request.headers.get("x-csrf-token") ?? "";
  if (!(await verifyCsrfToken(locals.user.csrfSecret, csrf))) {
    throw error(403, "CSRF token mismatch");
  }

  const body = (await request.json()) as {
    chatSessionId?: string;
    pinnedElements?: PinnedElementInput[];
  };
  if (!body.chatSessionId || typeof body.chatSessionId !== "string") {
    throw error(400, "chatSessionId required");
  }
  if (!Array.isArray(body.pinnedElements)) {
    throw error(400, "pinnedElements must be an array");
  }

  const { adapter, registry } = getQueryContext();
  const result = await execute(registry, adapter, locals.ctx, "chat.set_pinned_elements", {
    chatSessionId: body.chatSessionId,
    pinnedElements: body.pinnedElements,
  });
  if (!result.ok) throw error(500, "could not persist pinned elements");
  return json({ ok: true });
};
