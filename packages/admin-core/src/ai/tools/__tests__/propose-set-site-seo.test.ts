// SPDX-License-Identifier: MPL-2.0

/**
 * Tool-boundary contract of `propose_set_site_seo` / `get_site_seo`: the
 * Zod schema the dispatcher validates against, the JSON Schema the model
 * sees, the gate markers, and the Power-MCP catalogue reaching it.
 */

import { describe, expect, it } from "bun:test";
import { POWER_MCP_EXCLUDED_TOOLS, powerToolCatalogue } from "../../../ops/security/mcp_power.js";
import { createDefaultToolRegistry } from "../index.js";
import { getSiteSeoTool, proposeSetSiteSeoTool } from "../propose-set-site-seo.js";

describe("propose_set_site_seo", () => {
  it("is gated through site_defaults.propose_set_seo → execute_proposal", () => {
    expect(proposeSetSiteSeoTool.approvalMode).toBe("user-approval");
    expect(proposeSetSiteSeoTool.gated).toEqual({
      proposeOp: "site_defaults.propose_set_seo",
      executeOp: "site_defaults.execute_proposal",
    });
  });

  it("validates arguments at the tool boundary", () => {
    const s = proposeSetSiteSeoTool.schema;
    expect(s.safeParse({ siteBaseUrl: "https://www.example.com" }).success).toBe(true);
    expect(s.safeParse({ sitemapEnabled: false }).success).toBe(true);
    expect(s.safeParse({}).success).toBe(false);
    expect(s.safeParse({ siteBaseUrl: "https://x.example", siteLanguage: "de" }).success).toBe(
      false,
    );
    expect(s.safeParse({ sitemapEnabled: "yes" }).success).toBe(false);
  });

  it("advertises exactly the fields the schema accepts", () => {
    const props = Object.keys(
      (proposeSetSiteSeoTool.inputSchema as { properties: Record<string, unknown> }).properties,
    ).sort();
    expect(props).toEqual(["organizationJson", "siteBaseUrl", "sitemapEnabled"]);
  });

  it("routes the site language and per-page SEO to their own tools", () => {
    expect(proposeSetSiteSeoTool.description).toContain("set_site_identity({siteLanguage})");
    expect(proposeSetSiteSeoTool.description).toContain("set_page_seo");
  });

  it("is registered in the chat catalogue and offered on the Power-MCP surface", () => {
    const registry = createDefaultToolRegistry();
    const names = registry.catalogue().map((t) => t.name);
    expect(names).toContain("propose_set_site_seo");
    expect(names).toContain("get_site_seo");
    expect(POWER_MCP_EXCLUDED_TOOLS.has("propose_set_site_seo")).toBe(false);
    const mcp = powerToolCatalogue(registry).find((t) => t.name === "propose_set_site_seo");
    expect(mcp?.gated).toBe(true);
  });
});

describe("get_site_seo", () => {
  it("takes no arguments", () => {
    expect(getSiteSeoTool.schema.safeParse({}).success).toBe(true);
    expect(getSiteSeoTool.schema.safeParse({ x: 1 }).success).toBe(false);
  });
});
