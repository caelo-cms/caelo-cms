// SPDX-License-Identifier: MPL-2.0

/**
 * P17 PR4 — MCP server bridge endpoint.
 *
 * Inbound: `bunx @caelo/mcp-server` POSTs here with the bearer in
 * `x-caelo-mcp-token` and the chat input in the JSON body. We dispatch
 * `mcp.send_chat` (system-only op) which resolves the bearer to a
 * Caelo actor and drives `runChatTurn`. Auth lives entirely inside
 * the op — this endpoint is just an HTTP shell.
 *
 * No CSRF check (this is an API surface for non-browser clients; the
 * bearer IS the auth). No cookie session lookup. Errors are returned
 * as structured JSON, not as redirects.
 */

import { execute } from "@caelo/query-api";
import type { ExecutionContext } from "@caelo/shared";
import { error, json } from "@sveltejs/kit";
import { getQueryContext } from "$lib/server/query.js";
import type { RequestHandler } from "./$types";

const SYSTEM_CTX: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "mcp-http",
};

export const POST: RequestHandler = async ({ request }) => {
  const token = request.headers.get("x-caelo-mcp-token");
  if (!token) throw error(401, "missing x-caelo-mcp-token header");

  let body: { message?: unknown; chatSessionId?: unknown; pageId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    throw error(400, "body is not valid JSON");
  }
  if (typeof body.message !== "string" || body.message.length === 0) {
    throw error(400, "message must be a non-empty string");
  }

  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, SYSTEM_CTX, "mcp.send_chat", {
    plaintextToken: token,
    message: body.message,
    ...(typeof body.chatSessionId === "string" ? { chatSessionId: body.chatSessionId } : {}),
    ...(typeof body.pageId === "string" ? { pageId: body.pageId } : {}),
  });

  if (!r.ok) {
    const msg = "message" in r.error ? r.error.message : r.error.kind;
    // auth errors → 401; everything else → 500. The bridge surfaces the
    // error.message verbatim so MCP clients see "auth_error: token
    // revoked" / "chat_error: …" / "session_not_found" cleanly.
    if (typeof msg === "string" && msg.startsWith("auth_error:")) {
      throw error(401, msg);
    }
    throw error(500, typeof msg === "string" ? msg : "mcp.send_chat failed");
  }
  return json(r.value);
};
