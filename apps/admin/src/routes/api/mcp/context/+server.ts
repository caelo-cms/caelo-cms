// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #376 — Power-MCP: site-context endpoint. Serves the external
 * agent the same composed context the chat-runner's system prompt
 * carries (module model, tool playbook, staging, site memory, skills
 * index) plus the cold-start status line and the active skills. The
 * `includeSkillBodies` flag feeds the `caelo-mcp-server export`
 * CLAUDE.md/skills generator. Auth lives inside the op.
 */

import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { error, json } from "@sveltejs/kit";
import { getQueryContext } from "$lib/server/query.js";
import type { RequestHandler } from "./$types";

const SYSTEM_CTX: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "mcp-http-context",
};

export const POST: RequestHandler = async ({ request }) => {
  const token = request.headers.get("x-caelo-mcp-token");
  if (!token) throw error(401, "missing x-caelo-mcp-token header");

  let body: { includeSkillBodies?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    throw error(400, "body is not valid JSON");
  }

  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, SYSTEM_CTX, "mcp.get_context", {
    plaintextToken: token,
    ...(typeof body.includeSkillBodies === "boolean"
      ? { includeSkillBodies: body.includeSkillBodies }
      : {}),
  });

  if (!r.ok) {
    const msg = "message" in r.error ? r.error.message : r.error.kind;
    if (typeof msg === "string" && msg.startsWith("auth_error:")) {
      throw error(401, msg);
    }
    throw error(500, typeof msg === "string" ? msg : "mcp.get_context failed");
  }
  return json(r.value);
};
