// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #658 — Power-MCP: read the operator's decision on a proposal the
 * external agent queued (approve / reject happens in the Caelo admin). The
 * MCP server polls this while the agent's gated tool call waits. Auth +
 * ownership live inside the op; this is just the HTTP shell.
 */

import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { error, json } from "@sveltejs/kit";
import { getQueryContext } from "#lib/server/query.js";
import type { RequestHandler } from "./$types";

const SYSTEM_CTX: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "mcp-http-approval",
};

export const POST: RequestHandler = async ({ request }) => {
  const token = request.headers.get("x-caelo-mcp-token");
  if (!token) throw error(401, "missing x-caelo-mcp-token header");

  let body: { proposalId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    throw error(400, "body is not valid JSON");
  }
  if (typeof body.proposalId !== "string" || body.proposalId.length === 0) {
    throw error(400, "proposalId must be the id from the gated tool's 'Queued proposal' result");
  }

  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, SYSTEM_CTX, "mcp.get_approval_outcome", {
    plaintextToken: token,
    proposalId: body.proposalId,
  });
  if (!r.ok) {
    const msg = "message" in r.error ? r.error.message : r.error.kind;
    if (typeof msg === "string" && msg.startsWith("auth_error:")) throw error(401, msg);
    if (typeof msg === "string" && msg.startsWith("approval_not_found:")) throw error(404, msg);
    if (r.error.kind === "ValidationFailed") {
      throw error(
        400,
        `invalid request: ${JSON.stringify("issues" in r.error ? r.error.issues : [])}`,
      );
    }
    throw error(500, typeof msg === "string" ? msg : "mcp.get_approval_outcome failed");
  }
  return json(r.value);
};
