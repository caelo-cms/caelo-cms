// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #764 — version handshake. The MCP shim POSTs here at startup and
 * re-execs as the returned release when its own differs, so the
 * `claude mcp add` command stays version-free across admin upgrades.
 * Auth (any live token) lives inside the op; this is just the HTTP shell.
 */

import { execute } from "@caelo-cms/query-api";
import { error, json } from "@sveltejs/kit";
import { getQueryContext } from "#lib/server/query.js";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request }) => {
  const token = request.headers.get("x-caelo-mcp-token");
  if (!token) throw error(401, "missing x-caelo-mcp-token header");

  const { adapter, registry } = getQueryContext();
  const r = await execute(
    registry,
    adapter,
    {
      actorId: "00000000-0000-0000-0000-00000000ffff",
      actorKind: "system",
      requestId: "mcp-http-version",
    },
    "mcp.get_version",
    { plaintextToken: token },
  );
  if (!r.ok) {
    const msg = "message" in r.error ? String(r.error.message) : r.error.kind;
    throw error(msg.startsWith("auth_error:") ? 401 : 500, msg);
  }
  return json(r.value);
};
