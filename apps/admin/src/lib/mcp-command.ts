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
 * The package is pinned to the admin's own version (`CAELO_VERSION`; all
 * workspace packages release in lockstep). An unpinned `bunx` resolves
 * `@latest` once and then serves that cache indefinitely, so a shim from
 * an older release kept running against a newer admin — e.g. 0.10.27
 * without IAP support against a 0.10.28 admin, failing with "Invalid IAP
 * credentials: empty token".
 */
export function claudeMcpAddCommand(args: {
  scope: string;
  adminUrl: string;
  token: string;
  iapServiceAccount: string | null;
  version: string;
}): string {
  const pkg = pinnedPackage(args.version);
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

/**
 * The optional one-shot `caelo-mcp-server export` command for admin
 * tokens: writes CLAUDE.md + `.claude/skills/` generated from the
 * install's live context into the current directory, for a persistent
 * repo-level context. Same env + version pin as the `claude mcp add`
 * command.
 */
export function caeloMcpExportCommand(args: {
  adminUrl: string;
  token: string;
  iapServiceAccount: string | null;
  version: string;
}): string {
  const lines = [
    `CAELO_ADMIN_URL=${args.adminUrl}`,
    `CAELO_MCP_TOKEN=${args.token}`,
    ...(args.iapServiceAccount ? [`CAELO_IAP_SERVICE_ACCOUNT=${args.iapServiceAccount}`] : []),
    `bunx --package ${pinnedPackage(args.version)} caelo-mcp-server export --out .`,
  ];
  return lines.join(" \\\n  ");
}

function pinnedPackage(version: string): string {
  return `@caelo-cms/mcp-server@${version}`;
}
