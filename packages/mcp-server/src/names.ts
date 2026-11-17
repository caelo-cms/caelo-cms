// SPDX-License-Identifier: MPL-2.0

/**
 * The names this package's programs go by (package.json `bin`) and the
 * commands of `caelo-mcp-server`. A leaf module: the surfaces the admin
 * runs in-process import it too.
 *
 * FROZEN for released shims (version-handshake.ts): `caelo-mcp-server` and
 * `caelo-admin-mcp` are re-run by name into newer releases.
 */

/** The chat server (`caelo_chat`), and the multi-command entry. */
export const CHAT_BIN = "caelo-mcp-server";

/** The Power-MCP server (issue #376). */
export const POWER_BIN = "caelo-power-mcp";

/**
 * {@link POWER_BIN}'s name before #1636. Client snippets handed out until
 * then name it, so it stays a second entry to the same server until 1.0
 * (#1638).
 */
export const LEGACY_POWER_BIN = "caelo-admin-mcp";

/** `caelo-mcp-server power`: the Power-MCP server as a command of {@link CHAT_BIN}. */
export const POWER_COMMAND = "power";

/** {@link POWER_COMMAND}'s name before #1636, still accepted until 1.0 (#1638). */
export const LEGACY_POWER_COMMAND = "admin";
