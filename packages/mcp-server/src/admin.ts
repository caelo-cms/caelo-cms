#!/usr/bin/env bun
// SPDX-License-Identifier: MPL-2.0

/**
 * `caelo-admin-mcp` — the name `caelo-power-mcp` had before #1636. Every
 * client snippet Settings → MCP handed out until then names it, and
 * released shims re-run it by this name (version-handshake.ts), so it
 * stays as a second entry to the same server until 1.0 (#1638).
 */

import { LEGACY_POWER_BIN } from "./names.js";
import { runPowerBin } from "./power-bin.js";

await runPowerBin(LEGACY_POWER_BIN);
