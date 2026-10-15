// SPDX-License-Identifier: MPL-2.0

/**
 * The `claude mcp add` command /settings/mcp shows after minting a token.
 *
 * `claude mcp add` syntax: options first, the server command after `--`
 * (there is no --command flag in the Claude Code CLI). Admin-scoped tokens
 * wire the Power-MCP binary (full tool catalogue, external agent drives the
 * loop); chat tokens wire the caelo_chat shim.
 *
 * On IAP-protected installs (gcp / gcp-firebase) the admin knows its MCP
 * service account from `CAELO_MCP_IAP_SERVICE_ACCOUNT` (set by the
 * provisioner); the command then carries `CAELO_IAP_SERVICE_ACCOUNT` so the
 * shim can get through IAP (issue #37) without any manual configuration.
 *
 * The command carries no version (#764): the shim asks the admin for its
 * release at startup and re-execs as exactly that one, so an upgraded
 * admin never keeps talking to the shim bunx cached (#552) and the
 * operator never has to regenerate the command.
 */
export function claudeMcpAddCommand(args: {
  scope: string;
  adminUrl: string;
  token: string;
  iapServiceAccount: string | null;
}): string {
  const pkg = "@caelo-cms/mcp-server";
  const lines = [
    args.scope === "admin" ? "claude mcp add caelo-admin" : "claude mcp add caelo",
    `--env CAELO_ADMIN_URL=${args.adminUrl}`,
    `--env CAELO_MCP_TOKEN=${args.token}`,
    ...(args.iapServiceAccount
      ? [`--env CAELO_IAP_SERVICE_ACCOUNT=${args.iapServiceAccount}`]
      : []),
    args.scope === "admin" ? `-- bunx --package ${pkg} caelo-admin-mcp` : `-- bunx ${pkg}`,
  ];
  return lines.join(" \\\n  ");
}
