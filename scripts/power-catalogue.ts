#!/usr/bin/env bun
// SPDX-License-Identifier: MPL-2.0

/**
 * #841 — the Power-MCP tool catalogue as of a release, shipped in
 * `@caelo-cms/mcp-server` as `power-catalogue.json`.
 *
 *   bun scripts/power-catalogue.ts --write   # regenerate the file
 *   bun scripts/power-catalogue.ts --check   # fail when it is stale
 *
 * A configured Power-MCP server always lists the catalogue its admin
 * serves live (`mcp.list_tools`). This snapshot exists only so that
 * MCP directories, which start the server without credentials, see the
 * same tools an operator gets — not just the four local companions.
 *
 * It is the core catalogue exactly as `mcp.list_tools` builds it, for a
 * token with the default `allow_caelo_ai = false` (so AI-spending tools
 * carry the delegation note, as for a freshly minted token). Plugin
 * tools are per install and therefore absent.
 *
 * scripts/release.ts regenerates it in every release commit, and
 * release.yml's gate runs `--check` so a tag whose snapshot is stale
 * does not ship. PR CI deliberately does not: between releases `main`
 * carries the last release's catalogue, which only affects directory
 * listings, never a configured server — failing every PR that touches a
 * tool description over it would be noise.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createDefaultToolRegistry } from "../packages/admin-core/src/ai/tools/index.ts";
import { powerToolCatalogue } from "../packages/admin-core/src/ops/security/mcp_power.ts";

/** Where the snapshot ships: next to the mcp-server package.json. */
export const POWER_CATALOGUE_PATH = resolve(
  import.meta.dir,
  "../packages/mcp-server/power-catalogue.json",
);

/** The snapshot's file content for `version`. */
export function renderPowerCatalogue(version: string): string {
  const tools = powerToolCatalogue(createDefaultToolRegistry(), { aiDelegated: true });
  return `${JSON.stringify({ version, tools }, null, 2)}\n`;
}

/** Writes the snapshot unless `dryRun`; true when the content changed. */
export function writePowerCatalogue(version: string, dryRun: boolean): boolean {
  const next = renderPowerCatalogue(version);
  const current = readCurrent();
  if (current === next) return false;
  if (!dryRun) writeFileSync(POWER_CATALOGUE_PATH, next);
  return true;
}

/** Null when the shipped snapshot is what `version` would generate, else the problem. */
export function powerCatalogueProblem(version: string): string | null {
  const current = readCurrent();
  if (current === null) return `${POWER_CATALOGUE_PATH} is missing`;
  if (current !== renderPowerCatalogue(version)) {
    return `${POWER_CATALOGUE_PATH} is stale — run \`bun scripts/power-catalogue.ts --write\``;
  }
  return null;
}

function readCurrent(): string | null {
  try {
    return readFileSync(POWER_CATALOGUE_PATH, "utf8");
  } catch {
    return null;
  }
}

if (import.meta.main) {
  const { CAELO_VERSION } = await import("../packages/shared/src/version.ts");
  const mode = process.argv[2];
  if (mode === "--write") {
    const changed = writePowerCatalogue(CAELO_VERSION, false);
    console.log(changed ? `✓ ${POWER_CATALOGUE_PATH} regenerated` : "✓ already current");
  } else if (mode === "--check") {
    const problem = powerCatalogueProblem(CAELO_VERSION);
    if (problem) {
      console.error(`✗ ${problem}`);
      process.exit(1);
    }
    console.log("✓ power-catalogue.json is current");
  } else {
    console.error("Usage: bun scripts/power-catalogue.ts --write | --check");
    process.exit(2);
  }
}
