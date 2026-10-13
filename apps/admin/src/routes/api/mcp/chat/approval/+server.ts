// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #658 — caelo_chat: the state of the caller's paused chat turn. A
 * gated tool paused the turn on approval cards that the operator decides in
 * the Caelo admin (the Live Edit chat marks them as the external agent's).
 * The MCP server polls this while the agent waits, and resumes the turn via
 * `/api/mcp/chat` with `resumeApprovals: true` once every card is decided.
 * Read-only; auth lives inside the op (bearer in `x-caelo-mcp-token`).
 */

import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { error, json } from "@sveltejs/kit";
import { z } from "zod";
import { getQueryContext } from "#lib/server/query.js";
import type { RequestHandler } from "./$types";

const SYSTEM_CTX: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "mcp-http-chat-approval",
};

export const POST: RequestHandler = async ({ request }) => {
  const token = request.headers.get("x-caelo-mcp-token");
  if (!token) throw error(401, "missing x-caelo-mcp-token header");
  const parsed = z
    .object({ chatSessionId: z.string().uuid() })
    .strict()
    .safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    throw error(400, "chatSessionId must be the chat id from the caelo_chat reply");
  }

  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, SYSTEM_CTX, "mcp.get_chat_approval_state", {
    plaintextToken: token,
    chatSessionId: parsed.data.chatSessionId,
  });
  if (!r.ok) {
    const msg = "message" in r.error ? r.error.message : r.error.kind;
    if (typeof msg === "string" && msg.startsWith("auth_error:")) throw error(401, msg);
    throw error(500, typeof msg === "string" ? msg : "mcp.get_chat_approval_state failed");
  }
  return json(r.value);
};
