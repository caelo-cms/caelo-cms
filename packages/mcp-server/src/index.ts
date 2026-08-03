#!/usr/bin/env bun
// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/mcp-server — entrypoint.
 *
 * Three modes, selected by the first argument:
 *
 * - (none)   — the chat MCP server: exactly one tool (`caelo_chat`) that
 *              talks to Caelo's own AI agent. Works with any token scope.
 * - `admin`  — the Power-MCP server (issue #376): the full chat-runner
 *              tool catalogue for an external agent that drives the tool
 *              loop itself. Requires an admin-scoped token. Also
 *              available as the `caelo-admin-mcp` binary.
 * - `export` — writes CLAUDE.md + .claude/skills/ files generated from
 *              the install's live context into `--out <dir>` (default:
 *              the current directory). Requires an admin-scoped token.
 *
 * Bridge model: every mode is a thin shim. Calls become HTTP POSTs
 * against the admin install's `/api/mcp/*` endpoints, which dispatch
 * system-scoped ops that resolve the bearer to a Caelo actor. The MCP
 * server NEVER touches the database directly.
 */

import { startAdminMcpServer } from "./admin-server.js";
import { runExport } from "./export.js";
import { startMcpServer } from "./server.js";

const adminUrl = process.env.CAELO_ADMIN_URL;
const token = process.env.CAELO_MCP_TOKEN;

if (!adminUrl) {
  console.error(
    "CAELO_ADMIN_URL not set — point me at your admin install (e.g. https://admin.example.com)",
  );
  process.exit(2);
}
if (!token) {
  console.error("CAELO_MCP_TOKEN not set — mint one at /security/mcp on your admin install");
  process.exit(2);
}

const command = process.argv[2];

if (command === "export") {
  const outFlag = process.argv.indexOf("--out");
  const outDir = outFlag !== -1 ? process.argv[outFlag + 1] : undefined;
  if (outFlag !== -1 && !outDir) {
    console.error("--out needs a directory argument");
    process.exit(2);
  }
  const written = await runExport({ adminUrl, token, outDir: outDir ?? process.cwd() });
  for (const path of written) console.log(path);
  console.log(`exported ${written.length} file(s) — re-run after skills or site memory change`);
} else if (command === "admin") {
  await startAdminMcpServer({ adminUrl, token });
} else if (command !== undefined) {
  console.error(`unknown command: ${command} (expected no command, "admin", or "export")`);
  process.exit(2);
} else {
  await startMcpServer({ adminUrl, token });
}
