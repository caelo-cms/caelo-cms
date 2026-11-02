// SPDX-License-Identifier: MPL-2.0

/**
 * #1328 — the pre-flight cost table shows the MCP-Auth-Proxy on both GCP
 * variants, its own Cloud Armor policy on `gcp`, and the gcp-firebase data
 * gateway (CLAUDE.md §11.C: every billable resource has a cost line).
 */

import { describe, expect, it } from "bun:test";
import { type CostEstimateInputs, estimateGcpCost, schedulerTickMonthlyUsd } from "./gcp-cost.js";

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

describe("cost table: scheduler tick (#1140)", () => {
  it("lists the tick at the default 5 minutes: well under a dollar", () => {
    const line = estimateGcpCost(inputs).lines.find((l) => l.name.startsWith("Scheduler tick"));
    expect(line?.name).toBe("Scheduler tick (Cloud Scheduler + Workflows, every 5 min)");
    // 8,640 ticks: 25,920 internal steps (20,920 billed) + 8,640 external
    // (6,640 billed) + the scheduler job.
    expect(line?.monthlyUsd).toBe(0.48);
  });

  it("follows the knob: one minute stays a few dollars, fifteen little more than the job", () => {
    expect(schedulerTickMonthlyUsd(1)).toBe(2.38);
    expect(schedulerTickMonthlyUsd(15)).toBe(0.16);
    const fast = estimateGcpCost({ ...inputs, schedulerIntervalMinutes: 1 }).lines.find((l) =>
      l.name.startsWith("Scheduler tick"),
    );
    expect(fast?.name).toContain("every 1 min");
  });

  it("refuses an interval outside 1-15 minutes", () => {
    expect(() => estimateGcpCost({ ...inputs, schedulerIntervalMinutes: 20 })).toThrow(
      "between 1 and 15",
    );
  });
});
