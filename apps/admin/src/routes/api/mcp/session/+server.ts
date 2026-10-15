// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #376 — Power-MCP: work-session endpoint. Resumes the token owner's
 * most recent open chat session (issue #620), resumes a named one, or opens
 * a fresh one (newSession) — the session whose preview branch every
 * subsequent /api/mcp/tool call writes to. Auth lives inside the op; this
 * is just the HTTP shell.
 */

import { execute } from "@caelo-cms/query-api";
import { error, json } from "@sveltejs/kit";
import { mcpOpFailure, mcpSystemCtx } from "#lib/server/mcp-http.js";
import { getQueryContext } from "#lib/server/query.js";
import type { RequestHandler } from "./$types";

const SYSTEM_CTX = mcpSystemCtx("mcp-http-session");

export const POST: RequestHandler = async ({ request }) => {
  const token = request.headers.get("x-caelo-mcp-token");
  if (!token) throw error(401, "missing x-caelo-mcp-token header");

  let body: { chatSessionId?: unknown; newSession?: unknown; title?: unknown; pageId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    throw error(400, "body is not valid JSON");
  }

  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, SYSTEM_CTX, "mcp.open_session", {
    plaintextToken: token,
    ...(typeof body.chatSessionId === "string" ? { chatSessionId: body.chatSessionId } : {}),
    ...(typeof body.newSession === "boolean" ? { newSession: body.newSession } : {}),
    ...(typeof body.title === "string" ? { title: body.title } : {}),
    ...(typeof body.pageId === "string" ? { pageId: body.pageId } : {}),
  });

  if (!r.ok) {
    const failure = mcpOpFailure(r.error, "mcp.open_session");
    throw error(failure.status, failure.message);
  }
  return json(r.value);
};
