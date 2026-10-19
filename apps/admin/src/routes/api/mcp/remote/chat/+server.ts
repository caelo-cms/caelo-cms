// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #806 — remote MCP Streamable HTTP endpoint, chat surface (caelo_chat).
 * Reached through Google IAP with the user's own Google identity (the
 * gateway's OAuth broker forwards the client's bearer); authentication,
 * the MCP server and the transport live in #lib/server/mcp-remote.ts.
 * No cookie session and no CSRF check: the IAP assertion IS the auth.
 */

import { handleRemoteMcpRequest } from "#lib/server/mcp-remote.js";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = ({ request }) => handleRemoteMcpRequest(request, "chat");
export const GET: RequestHandler = ({ request }) => handleRemoteMcpRequest(request, "chat");
export const DELETE: RequestHandler = ({ request }) => handleRemoteMcpRequest(request, "chat");
