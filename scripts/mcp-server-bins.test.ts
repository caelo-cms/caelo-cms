// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1636 — the names of `@caelo-cms/mcp-server`'s programs are written
 * in three places that cannot import each other: the package's own
 * `package.json` (`bin`) and `src/names.ts` (it is published on its own),
 * and `@caelo-cms/shared`, from which the admin announces them in the
 * shim's version handshake and builds the client snippets. A shim started
 * as `caelo-power-mcp` decides from that announcement which name to re-run
 * in the admin's release, so a list that drifts sends it to a program the
 * release does not have.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CHAT_BIN,
  LEGACY_POWER_BIN,
  LEGACY_POWER_COMMAND,
  POWER_BIN,
  POWER_COMMAND,
} from "../packages/mcp-server/src/names.ts";
import {
  LEGACY_POWER_SURFACE_NAME,
  MCP_POWER_BIN,
  MCP_SERVER_BINS,
} from "../packages/shared/src/mcp-access.ts";

const PKG_DIR = resolve(import.meta.dir, "../packages/mcp-server");
const pkg = JSON.parse(readFileSync(resolve(PKG_DIR, "package.json"), "utf8")) as {
  bin: Record<string, string>;
};

describe("@caelo-cms/mcp-server program names (#1636)", () => {
  it("package.json ships exactly the programs the admin announces", () => {
    expect(Object.keys(pkg.bin).sort()).toEqual([...MCP_SERVER_BINS].sort());
    expect(Object.keys(pkg.bin).sort()).toEqual([CHAT_BIN, POWER_BIN, LEGACY_POWER_BIN].sort());
  });

  it("every program has its source entry", () => {
    for (const [name, dist] of Object.entries(pkg.bin)) {
      const source = dist.replace("./dist/", "src/").replace(/\.js$/, ".ts");
      expect(`${name}: ${existsSync(resolve(PKG_DIR, source))}`).toBe(`${name}: true`);
    }
  });

  it("the admin's snippets name the Power-MCP program by its current name", () => {
    expect(MCP_POWER_BIN).toBe(POWER_BIN);
    expect(POWER_BIN).toBe("caelo-power-mcp");
    expect(POWER_COMMAND).toBe("power");
  });

  it("the names from before the rename are the surface's old name, kept as second entries", () => {
    expect(LEGACY_POWER_COMMAND).toBe(LEGACY_POWER_SURFACE_NAME);
    expect(LEGACY_POWER_BIN).toBe(`caelo-${LEGACY_POWER_SURFACE_NAME}-mcp`);
    // Both entries start the same server.
    const entry = (file: string) => readFileSync(resolve(PKG_DIR, "src", file), "utf8");
    expect(entry("power.ts")).toContain("await runPowerBin(POWER_BIN);");
    expect(entry("admin.ts")).toContain("await runPowerBin(LEGACY_POWER_BIN);");
  });
});
