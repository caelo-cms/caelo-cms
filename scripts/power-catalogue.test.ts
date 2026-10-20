// SPDX-License-Identifier: MPL-2.0
/**
 * #841 — the shipped Power-MCP snapshot is the catalogue `mcp.list_tools`
 * serves to a default token, stamped with the release it belongs to.
 */
import { describe, expect, it } from "bun:test";
import { createDefaultToolRegistry } from "../packages/admin-core/src/ai/tools/index.ts";
import { powerToolCatalogue } from "../packages/admin-core/src/ops/security/mcp_power.ts";
import { powerCatalogueProblem, renderPowerCatalogue } from "./power-catalogue.ts";

describe("#841 power-catalogue snapshot", () => {
  it("renders the default-token catalogue with its release version", () => {
    const rendered = JSON.parse(renderPowerCatalogue("9.9.9")) as {
      version: string;
      tools: Array<{ name: string }>;
    };
    expect(rendered.version).toBe("9.9.9");
    const live = powerToolCatalogue(createDefaultToolRegistry(), { aiDelegated: true });
    expect(rendered.tools.map((t) => t.name)).toEqual(live.map((t) => t.name));
  });

  it("calls a snapshot from another release stale", () => {
    expect(powerCatalogueProblem("0.0.0-not-this-release")).toContain("is stale");
  });
});
