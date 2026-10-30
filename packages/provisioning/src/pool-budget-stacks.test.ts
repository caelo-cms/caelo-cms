// SPDX-License-Identifier: MPL-2.0

/**
 * #1254 — every adapter sizes its pools from the connection budget
 * (CLAUDE.md §11.C: all four adapters). Pins the numbers each stack's
 * defaults produce and that each stack actually sets them on its services.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { COMPOSE_POOL_BUDGET } from "./compose.js";
import {
  type BudgetProvider,
  DEFAULT_GATEWAY_MAX_INSTANCES,
  DEFAULT_MAX_CONNECTIONS,
  stackPoolBudget,
} from "./pool-budget-stack.js";

const stackSource = (provider: string): string =>
  readFileSync(resolve(import.meta.dir, "..", "stacks", provider, "index.ts"), "utf8");

/** Each stack's default scale-out, as its index.ts reads it. */
const DEFAULT_SCALE: Record<BudgetProvider, { admin: number; gateway: number }> = {
  gcp: { admin: 5, gateway: DEFAULT_GATEWAY_MAX_INSTANCES },
  "gcp-firebase": { admin: 5, gateway: DEFAULT_GATEWAY_MAX_INSTANCES },
  aws: { admin: 5, gateway: DEFAULT_GATEWAY_MAX_INSTANCES },
  // admin + orchestrator + runner apps, 10 replicas each.
  azure: { admin: 30, gateway: 10 },
  "self-hosted": { admin: 1, gateway: 1 },
};

/** [cms_admin pool per admin instance, connections left unassigned]. */
const EXPECTED: Record<BudgetProvider, [number, number]> = {
  gcp: [5, 1],
  "gcp-firebase": [5, 1],
  aws: [5, 3],
  azure: [7, 12],
  "self-hosted": [77, 0],
};

describe("stack pool budgets at the default config", () => {
  for (const provider of Object.keys(EXPECTED) as BudgetProvider[]) {
    it(`${provider}: pools fit max_connections ${DEFAULT_MAX_CONNECTIONS[provider]}`, () => {
      const { budget, env } = stackPoolBudget(provider, {
        maxConnections: DEFAULT_MAX_CONNECTIONS[provider],
        adminMaxInstances: DEFAULT_SCALE[provider].admin,
        gatewayMaxInstances: DEFAULT_SCALE[provider].gateway,
      });
      expect([budget.adminPoolMax, budget.unassigned]).toEqual(EXPECTED[provider]);
      expect(env.admin).toEqual([
        { name: "CAELO_DB_POOL_MAX", value: String(EXPECTED[provider][0]) },
        { name: "CAELO_DB_PUBLIC_POOL_MAX", value: "4" },
      ]);
      expect(env.gateway).toEqual([{ name: "CAELO_DB_PUBLIC_POOL_MAX", value: "2" }]);
    });
  }

  it("refuses the pre-#1254 GCP gateway scale-out of 100 on 100 slots", () => {
    expect(() =>
      stackPoolBudget("gcp", {
        maxConnections: 100,
        adminMaxInstances: 5,
        gatewayMaxInstances: 100,
      }),
    ).toThrow(/Raise maxConnections/);
  });
});

describe("stacks set the budget on their services", () => {
  for (const provider of ["gcp", "gcp-firebase"]) {
    it(`${provider}: admin + gateway env, gateway scale-out from the knob`, () => {
      const src = stackSource(provider);
      expect(src).toContain(`stackPoolBudget("${provider}"`);
      expect(src).toContain("...poolBudget.env.admin");
      expect(src).toContain("...poolBudget.env.gateway");
      expect(src).toContain("maxInstances: gatewayMaxInstances");
      expect(src).not.toContain("maxInstances: 100");
    });
  }

  it("aws: pins max_connections and exports the task env", () => {
    const src = stackSource("aws");
    expect(src).toContain('stackPoolBudget("aws"');
    expect(src).toContain('name: "max_connections"');
    expect(src).toContain("export const poolBudgetEnvOut = poolBudget.env");
  });

  it("azure: pins max_connections and sets the env on every app", () => {
    const src = stackSource("azure");
    expect(src).toContain('stackPoolBudget("azure"');
    expect(src).toContain('configurationName: "max_connections"');
    expect(src).toContain("...poolBudget.env.admin");
    expect(src).toContain("...poolBudget.env.gateway");
  });

  it("self-hosted: the Compose budget is the default one (yaml: self-hosted-compose.test.ts)", () => {
    expect(COMPOSE_POOL_BUDGET.budget.adminPoolMax).toBe(EXPECTED["self-hosted"][0]);
  });
});
