#!/usr/bin/env bun
// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo/mcp-server — entrypoint.
 *
 * Reads `CAELO_ADMIN_URL` + `CAELO_MCP_TOKEN` from env, builds an MCP
 * server exposing exactly one tool (`caelo_chat`), and listens over
 * stdio (Claude Code's default invocation pattern).
 *
 * Bridge model: this process is a thin shim. Every `caelo_chat` call
 * becomes a single HTTP POST against the admin install's
 * `/api/mcp/chat` endpoint, which dispatches into the chat-runner with
 * the resolved actor identity. The MCP server NEVER touches the
 * database directly — it just translates between MCP semantics and
 * the admin's HTTP surface.
 */

import { startMcpServer } from "./server.js";

const adminUrl = process.env["CAELO_ADMIN_URL"];
const token = process.env["CAELO_MCP_TOKEN"];

if (!adminUrl) {
  console.error("CAELO_ADMIN_URL not set — point me at your admin install (e.g. https://admin.example.com)");
  process.exit(2);
}
if (!token) {
  console.error("CAELO_MCP_TOKEN not set — mint one at /security/mcp on your admin install");
  process.exit(2);
}

await startMcpServer({ adminUrl, token });
