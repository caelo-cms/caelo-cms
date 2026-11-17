#!/usr/bin/env bun

// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/mcp-server — entrypoint.
 *
 * Three modes, selected by the first argument:
 *
 * - (none)   — the chat MCP server: exactly one tool (`caelo_chat`) that
 *              talks to Caelo's own AI agent. Works with any token scope.
 * - `power`  — the Power-MCP server (issue #376): the full chat-runner
 *              tool catalogue for an external agent that drives the tool
 *              loop itself. Requires a token of scope `power`. Also
 *              available as the `caelo-power-mcp` binary. `admin` is the
 *              command's name from before #1636 and still accepted
 *              (until 1.0, #1638).
 * - `export` — writes CLAUDE.md + .claude/skills/ files generated from
 *              the install's live context into `--out <dir>` (default:
 *              the current directory). Requires a token of scope `power`.
 *
 * Bridge model: every mode is a thin shim. Calls become HTTP POSTs
 * against the admin install's `/api/mcp/*` endpoints, which dispatch
 * system-scoped ops that resolve the bearer to a Caelo actor. The MCP
 * server NEVER touches the database directly.
 *
 * Every mode first matches its release to the admin's (#764, see
 * ./version-handshake.ts), so the `claude mcp add` command carries no
 * version and survives admin upgrades. Without credentials the MCP modes
 * start unconfigured instead (#841, see ./unconfigured.ts).
 */

import { runExport } from "./export.js";
import { CHAT_BIN, LEGACY_POWER_COMMAND, POWER_COMMAND } from "./names.js";
import { startPowerMcpServer } from "./power-server.js";
import { startMcpServer } from "./server.js";
import { missingCredentials, startUnconfiguredServer } from "./unconfigured.js";
import { ensureAdminRelease } from "./version-handshake.js";

const command = process.argv[2];
const power = command === POWER_COMMAND || command === LEGACY_POWER_COMMAND;
if (command !== undefined && !power && command !== "export") {
  console.error(
    `unknown command: ${command} (expected no command, "${POWER_COMMAND}", or "export")`,
  );
  process.exit(2);
}

// #841 — the MCP modes start without credentials so directories can list
// their tools; `export` is a one-shot CLI with nothing to list, so it
// still exits.
const missing = missingCredentials(process.env);
if (missing.length > 0 && command !== "export") {
  await startUnconfiguredServer({ mode: power ? "power" : "chat", missing });
} else {
  const adminUrl = process.env.CAELO_ADMIN_URL;
  const token = process.env.CAELO_MCP_TOKEN;
  if (!adminUrl || !token) {
    console.error(
      `${missing.join(" and ")} not set — export needs CAELO_ADMIN_URL and a CAELO_MCP_TOKEN ` +
        "of scope 'power', minted at /settings/mcp on your admin install",
    );
    process.exit(2);
  }

  // #764 — run as the admin's own release (re-execs on a mismatch).
  await ensureAdminRelease({ adminUrl, token, bin: CHAT_BIN });

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
  } else if (power) {
    await startPowerMcpServer({ adminUrl, token });
  } else {
    await startMcpServer({ adminUrl, token });
  }
}
