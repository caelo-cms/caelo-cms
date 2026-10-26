// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #376 — Power-MCP: site-context endpoint. Serves the external
 * agent the same composed context the chat-runner's system prompt
 * carries (site model, tool playbook, staging, site memory, skills
 * index) plus the cold-start status line and the active skills. The
 * `includeSkillBodies` flag feeds the `caelo-mcp-server export`
 * CLAUDE.md/skills generator. Auth lives inside the op.
 */

import { execute } from "@caelo-cms/query-api";
import { error, json } from "@sveltejs/kit";
import { mcpOpFailure, mcpSystemCtx } from "#lib/server/mcp-http.js";
import { getQueryContext } from "#lib/server/query.js";
import type { RequestHandler } from "./$types";

const SYSTEM_CTX = mcpSystemCtx("mcp-http-context");

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
    const failure = mcpOpFailure(r.error, "mcp.get_context");
    throw error(failure.status, failure.message);
  }
  return json(r.value);
};
