// SPDX-License-Identifier: MPL-2.0

/**
 * The `claude mcp add` command /security/mcp shows after minting a token.
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
 * The package is pinned to the admin's own release (#552): bunx caches an
 * unversioned package indefinitely, so an upgraded admin kept talking to
 * an old shim. After an upgrade the operator regenerates the command.
 */
export function claudeMcpAddCommand(args: {
  scope: string;
  adminUrl: string;
  token: string;
  iapServiceAccount: string | null;
  /** The admin's release (CAELO_VERSION); mcp-server ships in lockstep. */
  version: string;
}): string {
  const pkg = `@caelo-cms/mcp-server@${args.version}`;
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
