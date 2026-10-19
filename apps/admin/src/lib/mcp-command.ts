// SPDX-License-Identifier: MPL-2.0

/**
 * The client setup snippets /settings/mcp shows after minting a token.
 *
 * Every client launches the same stdio server; only the way it is
 * registered differs. `mcpServerSpec` is the single source of the
 * server's name, command, args and env, and each client format below
 * renders that spec — so a change to the launch line (a new env var, a
 * different binary) reaches every client at once.
 *
 * Admin-scoped tokens wire the Power-MCP binary (full tool catalogue,
 * external agent drives the loop); chat tokens wire the caelo_chat shim.
 *
 * On IAP-protected installs (gcp / gcp-firebase) the admin knows its MCP
 * service account from `CAELO_MCP_IAP_SERVICE_ACCOUNT` (set by the
 * provisioner); the spec then carries `CAELO_IAP_SERVICE_ACCOUNT` so the
 * shim can get through IAP (issue #37) without any manual configuration.
 *
 * The launch line carries no release number (#764): the shim asks the
 * admin for its release at startup and re-execs as exactly that one, so
 * the operator never has to regenerate the snippet after an upgrade. It
 * does carry the `@latest` dist-tag: a bare package name lets bunx reuse
 * a cached install for up to a day (or a same-named binary on PATH),
 * which could be a shim from before the handshake that never asks (#552);
 * a dist-tag makes bunx resolve against the registry on every start.
 */

export interface McpCommandArgs {
  scope: string;
  adminUrl: string;
  token: string;
  iapServiceAccount: string | null;
}

/** The launch description every client format is rendered from. */
export interface McpServerSpec {
  /** Name in the client's server list; hyphen, not underscore (Gemini CLI rejects `_`). */
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

const PKG = "@caelo-cms/mcp-server@latest";

/** Name, launch line and env of the MCP server for one minted token. */
export function mcpServerSpec(args: McpCommandArgs): McpServerSpec {
  const admin = args.scope === "admin";
  return {
    name: admin ? "caelo-admin" : "caelo",
    command: "bunx",
    args: admin ? ["--package", PKG, "caelo-admin-mcp"] : [PKG],
    env: {
      CAELO_ADMIN_URL: args.adminUrl,
      CAELO_MCP_TOKEN: args.token,
      ...(args.iapServiceAccount ? { CAELO_IAP_SERVICE_ACCOUNT: args.iapServiceAccount } : {}),
    },
  };
}

/**
 * `claude mcp add` / `codex mcp add` — both CLIs share the syntax:
 * options first, the server command after `--` (there is no --command
 * flag). Runs in a terminal, not inside the agent.
 */
export function mcpAddCommand(cli: "claude" | "codex", args: McpCommandArgs): string {
  const spec = mcpServerSpec(args);
  const lines = [
    `${cli} mcp add ${spec.name}`,
    ...Object.entries(spec.env).map(([k, v]) => `--env ${k}=${v}`),
    `-- ${[spec.command, ...spec.args].join(" ")}`,
  ];
  return lines.join(" \\\n  ");
}

/** The Claude Code command — the client most operators start with. */
export function claudeMcpAddCommand(args: McpCommandArgs): string {
  return mcpAddCommand("claude", args);
}

/**
 * JSON config for clients configured by file. Claude Desktop, Cursor and
 * Gemini CLI read `{ "mcpServers": { … } }`; VS Code reads
 * `{ "servers": { … } }` with an explicit `"type": "stdio"`.
 */
export function mcpConfigJson(format: "mcpServers" | "vscode", args: McpCommandArgs): string {
  const spec = mcpServerSpec(args);
  const entry = {
    ...(format === "vscode" ? { type: "stdio" } : {}),
    command: spec.command,
    args: spec.args,
    env: spec.env,
  };
  const key = format === "vscode" ? "servers" : "mcpServers";
  return JSON.stringify({ [key]: { [spec.name]: entry } }, null, 2);
}
