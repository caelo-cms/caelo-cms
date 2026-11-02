// SPDX-License-Identifier: MPL-2.0

/**
 * #1328 — the pre-flight cost table shows the MCP-Auth-Proxy on both GCP
 * variants, its own Cloud Armor policy on `gcp`, and the gcp-firebase data
 * gateway (CLAUDE.md §11.C: every billable resource has a cost line).
 */

import { describe, expect, it } from "bun:test";
import { type CostEstimateInputs, estimateGcpCost } from "./gcp-cost.js";

const inputs: CostEstimateInputs = {
  cloudSqlTier: "db-f1-micro",
  cloudSqlHa: false,
  adminMinInstances: 0,
  gatewayMinInstances: 0,
  wafAdaptiveProtection: false,
  region: "europe-west1",
};

function names(provider: "gcp" | "gcp-firebase"): string[] {
  return estimateGcpCost({ ...inputs, provider }).lines.map((l) => l.name);
}

describe("cost table: MCP-Auth-Proxy (#1328)", () => {
  it("lists the proxy's Cloud Run service at $0 idle on both variants", () => {
    for (const provider of ["gcp", "gcp-firebase"] as const) {
      const line = estimateGcpCost({ ...inputs, provider }).lines.find(
        (l) => l.name === "Cloud Run MCP-Auth-Proxy",
      );
      expect(line?.monthlyUsd).toBe(0);
      expect(line?.notes).toContain("scale-to-zero");
    }
  });

  it("prices the proxy's own Cloud Armor policy on gcp only (policy + 2 rules)", () => {
    const gcp = estimateGcpCost({ ...inputs, provider: "gcp" }).lines.find((l) =>
      l.name.startsWith("MCP-Auth-Proxy backend"),
    );
    expect(gcp?.monthlyUsd).toBe(7);
    expect(names("gcp-firebase").some((n) => n.startsWith("MCP-Auth-Proxy backend"))).toBe(false);
    // The throttle moved off the gateway's policy: no separate rule line.
    expect(names("gcp")).not.toContain("Cloud Armor rule: remote MCP throttle");
  });

  it("names the gcp-firebase visitor gateway as the data gateway", () => {
    expect(names("gcp-firebase")).toContain("Cloud Run data gateway");
    expect(names("gcp")).toContain("Cloud Run gateway");
  });
});
