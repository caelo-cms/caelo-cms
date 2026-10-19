#!/usr/bin/env bun
// SPDX-License-Identifier: MPL-2.0

/**
 * `caelo-admin-mcp` — bin entry for the Power-MCP server (issue #376).
 * Equivalent to `caelo-mcp-server admin`; exists as its own binary so the
 * `claude mcp add` snippet stays a single flag-free command.
 */

import { startAdminMcpServer } from "./admin-server.js";
import { missingCredentials, startUnconfiguredServer } from "./unconfigured.js";
import { ensureAdminRelease } from "./version-handshake.js";

const adminUrl = process.env.CAELO_ADMIN_URL;
const token = process.env.CAELO_MCP_TOKEN;

if (!adminUrl || !token) {
  // #841 — answer tools/list for MCP directories; every call names the fix.
  await startUnconfiguredServer({ mode: "admin", missing: missingCredentials(process.env) });
} else {
  await ensureAdminRelease({ adminUrl, token, bin: "caelo-admin-mcp" });
  await startAdminMcpServer({ adminUrl, token });
}
