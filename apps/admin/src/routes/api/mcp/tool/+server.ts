// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #376 — Power-MCP: single-tool execution endpoint. One POST = one
 * tool dispatch with the same ExecutionContext the chat-runner would use
 * (AI actor, session branch, chatTaskId grouping). Auth + session +
 * cost-cap checks live inside the op; this is just the HTTP shell.
 */

import { execute } from "@caelo-cms/query-api";
import { error, json } from "@sveltejs/kit";
import { mcpOpFailure, mcpSystemCtx } from "#lib/server/mcp-http.js";
import { getQueryContext } from "#lib/server/query.js";
import type { RequestHandler } from "./$types";

const SYSTEM_CTX = mcpSystemCtx("mcp-http-tool");

export const POST: RequestHandler = async ({ request }) => {
  const token = request.headers.get("x-caelo-mcp-token");
  if (!token) throw error(401, "missing x-caelo-mcp-token header");

  let body: {
    toolName?: unknown;
    args?: unknown;
    chatSessionId?: unknown;
    toolCallId?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    throw error(400, "body is not valid JSON");
  }
  if (typeof body.toolName !== "string" || body.toolName.length === 0) {
    throw error(400, "toolName must be a non-empty string");
  }
  if (typeof body.chatSessionId !== "string" || body.chatSessionId.length === 0) {
    throw error(
      400,
      "chatSessionId must be a non-empty string (open a session via /api/mcp/session first)",
    );
  }

  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, SYSTEM_CTX, "mcp.execute_tool", {
    plaintextToken: token,
    toolName: body.toolName,
    chatSessionId: body.chatSessionId,
    ...(body.args && typeof body.args === "object" ? { args: body.args } : {}),
    ...(typeof body.toolCallId === "string" ? { toolCallId: body.toolCallId } : {}),
  });

  if (!r.ok) {
    const failure = mcpOpFailure(r.error, "mcp.execute_tool");
    throw error(failure.status, failure.message);
  }
  return json(r.value);
};
