#!/usr/bin/env bun
// SPDX-License-Identifier: MPL-2.0

/**
 * `caelo-power-mcp` — bin entry for the Power-MCP server (issue #376).
 * Equivalent to `caelo-mcp-server power`; exists as its own binary so the
 * `claude mcp add` snippet stays a single flag-free command.
 */

import { POWER_BIN } from "./names.js";
import { runPowerBin } from "./power-bin.js";

await runPowerBin(POWER_BIN);
