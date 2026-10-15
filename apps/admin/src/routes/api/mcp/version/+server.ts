// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #764 — version handshake. The MCP shim POSTs here at startup and
 * re-execs as the returned release when its own differs, so the
 * `claude mcp add` command stays version-free across admin upgrades.
 * Auth (any live token) lives inside the op; this is just the HTTP shell.
 *
 * FROZEN PROTOCOL: every released shim calls this path (POST, bearer in
 * `x-caelo-mcp-token`) and expects `{ version: "<exact semver>" }` back —
 * see packages/mcp-server/src/version-handshake.ts. Never move, rename or
 * reshape it incompatibly; add fields only.
 */

import { execute } from "@caelo-cms/query-api";
import { error, json } from "@sveltejs/kit";
import { mcpOpFailure, mcpSystemCtx } from "#lib/server/mcp-http.js";
import { getQueryContext } from "#lib/server/query.js";
import type { RequestHandler } from "./$types";

const SYSTEM_CTX = mcpSystemCtx("mcp-http-version");

export const POST: RequestHandler = async ({ request }) => {
  const token = request.headers.get("x-caelo-mcp-token");
  if (!token) throw error(401, "missing x-caelo-mcp-token header");

  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, SYSTEM_CTX, "mcp.get_version", {
    plaintextToken: token,
  });
  if (!r.ok) {
    const failure = mcpOpFailure(r.error, "mcp.get_version");
    throw error(failure.status, failure.message);
  }
  return json(r.value);
};
