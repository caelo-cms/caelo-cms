// SPDX-License-Identifier: MPL-2.0

/**
 * What both Power-MCP bins run (`caelo-power-mcp`, and `caelo-admin-mcp`,
 * its name before #1636): the unconfigured server without credentials,
 * otherwise the version handshake and the Power-MCP stdio server.
 */

import type { LEGACY_POWER_BIN, POWER_BIN } from "./names.js";
import { startPowerMcpServer } from "./power-server.js";
import { missingCredentials, startUnconfiguredServer } from "./unconfigured.js";
import { ensureAdminRelease } from "./version-handshake.js";

/**
 * Start the Power-MCP server as `bin`.
 *
 * @param bin - the name this process was started under; a re-exec into the
 *   admin's release keeps it where that release has it.
 */
export async function runPowerBin(bin: typeof POWER_BIN | typeof LEGACY_POWER_BIN): Promise<void> {
  const adminUrl = process.env.CAELO_ADMIN_URL;
  const token = process.env.CAELO_MCP_TOKEN;
  if (!adminUrl || !token) {
    // #841 — answer tools/list for MCP directories; every call names the fix.
    await startUnconfiguredServer({ mode: "power", missing: missingCredentials(process.env) });
    return;
  }
  await ensureAdminRelease({ adminUrl, token, bin });
  await startPowerMcpServer({ adminUrl, token });
}
