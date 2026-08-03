// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #376 — Power-MCP: tool-catalogue endpoint. The admin-mode MCP
 * server fetches this once at startup and registers the entries as MCP
 * tools. Auth (admin-scoped bearer) lives inside the op; this is just
 * the HTTP shell — same shape as ../chat/+server.ts.
 */

import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { error, json } from "@sveltejs/kit";
import { getQueryContext } from "$lib/server/query.js";
import type { RequestHandler } from "./$types";

const SYSTEM_CTX: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "mcp-http-tools",
};

export const POST: RequestHandler = async ({ request }) => {
  const token = request.headers.get("x-caelo-mcp-token");
  if (!token) throw error(401, "missing x-caelo-mcp-token header");

  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, SYSTEM_CTX, "mcp.list_tools", {
    plaintextToken: token,
  });

  if (!r.ok) {
    const msg = "message" in r.error ? r.error.message : r.error.kind;
    if (typeof msg === "string" && msg.startsWith("auth_error:")) {
      throw error(401, msg);
    }
    // Op-input validation failures are the caller's mistake, not a server
    // fault — surface them as 400 with the issues (review finding, PR #379).
    if (r.error.kind === "ValidationFailed") {
      throw error(
        400,
        `invalid request: ${JSON.stringify("issues" in r.error ? r.error.issues : [])}`,
      );
    }
    throw error(500, typeof msg === "string" ? msg : "mcp.list_tools failed");
  }
  return json(r.value);
};
