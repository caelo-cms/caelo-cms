// SPDX-License-Identifier: MPL-2.0

/**
 * #1216 — older transcript pages for ChatPanel's "Show earlier messages".
 *
 * The chat views load only the newest page of a transcript; this returns
 * the page that ends just before `?before=<message id>`. Owner-scoped like
 * every session read (another user's chat reads as 404). GET only.
 */

import { error, json } from "@sveltejs/kit";
import { loadTranscriptPage } from "#lib/server/chat-transcript.js";
import { requirePermission } from "#lib/server/guards.js";
import type { RequestHandler } from "./$types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET: RequestHandler = async ({ params, url, locals }) => {
  requirePermission(locals, "content.read");
  const before = url.searchParams.get("before");
  if (!before || !UUID_RE.test(before)) throw error(400, "before must be a message UUID");
  if (!UUID_RE.test(params.sessionId)) throw error(404, "Chat not found");
  const page = await loadTranscriptPage(locals.ctx, params.sessionId, before);
  if (!page) throw error(404, "Chat not found");
  return json({ messages: page.messages, hasMore: page.hasMore });
};
