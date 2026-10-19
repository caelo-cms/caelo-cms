// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #841 — the server answers `initialize` + `tools/list` without
 * credentials, so MCP directories (Glama, the official registry's
 * scanners, awesome-mcp-servers via Glama) can inspect it. They start
 * the bin with no env and ask for the tool list; exiting there kept
 * Caelo unlisted.
 *
 * This is not a fallback in the CLAUDE.md §2 sense: nothing degrades
 * silently. The process says on stderr that it is unconfigured, and
 * every tool call fails with the variables to set. The version
 * handshake is skipped because there is no admin to ask — and it cannot
 * move to the first call instead: it re-execs the whole process as the
 * admin's release, which is only possible before the client's
 * `initialize` has been answered.
 *
 * Power-MCP's real catalogue comes from the admin, so unconfigured it
 * lists the snapshot shipped with this release (`power-catalogue.json`,
 * written by scripts/power-catalogue.ts at release cut) — directories
 * then show the tools an operator actually gets.
 */

import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  ADMIN_LOCAL_TOOLS,
  ADMIN_MCP_INSTRUCTIONS,
  CHAT_MCP_INSTRUCTIONS,
  CHAT_TOOLS,
} from "./tool-definitions.js";
import { ownVersion } from "./version-handshake.js";

const powerCatalogueSchema = z.object({
  version: z.string(),
  tools: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        inputSchema: z.record(z.string(), z.unknown()),
      }),
    )
    .min(1),
});

/**
 * The Power-MCP tools shipped with this release. Throws when the
 * snapshot is missing or malformed — a package without it is a broken
 * release, not something to list around.
 */
export function loadPowerCatalogue(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const raw = readFileSync(new URL("../power-catalogue.json", import.meta.url), "utf8");
  return powerCatalogueSchema
    .parse(JSON.parse(raw))
    .tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

/** The two variables every mode needs to reach an admin install. */
export type CredentialVar = "CAELO_ADMIN_URL" | "CAELO_MCP_TOKEN";

/** Which credential variables are unset or empty in `env`. */
export function missingCredentials(env: NodeJS.ProcessEnv): CredentialVar[] {
  return (["CAELO_ADMIN_URL", "CAELO_MCP_TOKEN"] as const).filter((name) => !env[name]);
}

/** The error every tool call returns while credentials are missing. */
export function describeMissingCredentials(
  mode: "chat" | "admin",
  missing: readonly CredentialVar[],
): string {
  const scope = mode === "admin" ? "an ADMIN-scoped" : "a";
  return (
    `This Caelo MCP server is not connected to a Caelo install: ${missing.join(" and ")} ` +
    `${missing.length === 1 ? "is" : "are"} not set. Set CAELO_ADMIN_URL to your admin's https:// address ` +
    `and CAELO_MCP_TOKEN to ${scope} token minted at /settings/mcp on that install, then restart the ` +
    "MCP server. The operator has to do this in the MCP client's config; retrying the call will not help."
  );
}

export interface StartUnconfiguredOpts {
  readonly mode: "chat" | "admin";
  readonly missing: readonly CredentialVar[];
  /** Defaults to stdio; tests pass an in-memory transport. */
  readonly transport?: Transport;
}

/** Serves the mode's tool list (see the file header) and fails every call. */
export async function startUnconfiguredServer(opts: StartUnconfiguredOpts): Promise<void> {
  const server = new Server(
    {
      name: opts.mode === "admin" ? "caelo-admin-mcp" : "caelo-mcp-server",
      version: ownVersion(),
    },
    {
      capabilities: { tools: {} },
      instructions: opts.mode === "admin" ? ADMIN_MCP_INSTRUCTIONS : CHAT_MCP_INSTRUCTIONS,
    },
  );
  const error = describeMissingCredentials(opts.mode, opts.missing);
  const tools =
    opts.mode === "admin" ? [...ADMIN_LOCAL_TOOLS, ...loadPowerCatalogue()] : [...CHAT_TOOLS];

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    isError: true,
    content: [{ type: "text", text: error }],
  }));

  // stderr: stdout is the stdio transport.
  console.error(`caelo mcp: ${error}`);
  await server.connect(opts.transport ?? new StdioServerTransport());
}
