#!/usr/bin/env bun
// SPDX-License-Identifier: MPL-2.0

/**
 * `caelo-admin-mcp` — bin entry for the Power-MCP server (issue #376).
 * Equivalent to `caelo-mcp-server admin`; exists as its own binary so the
 * `claude mcp add` snippet stays a single flag-free command.
 */

import { startAdminMcpServer } from "./admin-server.js";

const adminUrl = process.env.CAELO_ADMIN_URL;
const token = process.env.CAELO_MCP_TOKEN;

if (!adminUrl) {
  console.error(
    "CAELO_ADMIN_URL not set — point me at your admin install (e.g. https://admin.example.com)",
  );
  process.exit(2);
}
if (!token) {
  console.error(
    "CAELO_MCP_TOKEN not set — mint an ADMIN-scoped token at /security/mcp on your admin install",
  );
  process.exit(2);
}

await startAdminMcpServer({ adminUrl, token });
