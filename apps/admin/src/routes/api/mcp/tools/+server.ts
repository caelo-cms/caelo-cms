// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #376 — Power-MCP: tool-catalogue endpoint. The admin-mode MCP
 * server fetches this once at startup and registers the entries as MCP
 * tools. Auth (admin-scoped bearer) lives inside the op; this is just
 * the HTTP shell — same shape as ../chat/+server.ts.
 */

import { execute } from "@caelo-cms/query-api";
import { error, json } from "@sveltejs/kit";
import { mcpOpFailure, mcpSystemCtx } from "#lib/server/mcp-http.js";
import { getQueryContext } from "#lib/server/query.js";
import type { RequestHandler } from "./$types";

const SYSTEM_CTX = mcpSystemCtx("mcp-http-tools");

export const POST: RequestHandler = async ({ request }) => {
  const token = request.headers.get("x-caelo-mcp-token");
  if (!token) throw error(401, "missing x-caelo-mcp-token header");

  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, SYSTEM_CTX, "mcp.list_tools", {
    plaintextToken: token,
  });

  if (!r.ok) {
    const failure = mcpOpFailure(r.error, "mcp.list_tools");
    throw error(failure.status, failure.message);
  }
  return json(r.value);
};
