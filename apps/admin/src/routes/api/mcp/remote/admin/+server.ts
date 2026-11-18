// SPDX-License-Identifier: MPL-2.0

/**
 * The Power surface under its address from before #1636. The MCP-Auth-Proxy
 * forwards `/api/mcp/admin`, the URL of every connector added until then,
 * to this route, so those connectors keep working without being re-added.
 * It is the same endpoint as `../power`; the request is only marked, so
 * Settings → MCP can show the Owner which apps still come this way before
 * the address goes with 1.0 (#1638).
 */

import { handleRemoteMcpRequest } from "#lib/server/mcp-remote.js";
import type { RequestHandler } from "./$types";

const LEGACY = { legacyAddress: true } as const;

export const POST: RequestHandler = ({ request }) =>
  handleRemoteMcpRequest(request, "power", LEGACY);
export const GET: RequestHandler = ({ request }) =>
  handleRemoteMcpRequest(request, "power", LEGACY);
export const DELETE: RequestHandler = ({ request }) =>
  handleRemoteMcpRequest(request, "power", LEGACY);
