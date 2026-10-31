// SPDX-License-Identifier: MPL-2.0

/** Issue #1254 — the connection budget formula (pool-budget.ts). */

import { describe, expect, it } from "bun:test";
import {
  ADMIN_POOL_FLOOR,
  ADMIN_PUBLIC_POOL_MAX,
  computePoolBudget,
  DB_POOL_MAX_ENV,
  DB_PUBLIC_POOL_MAX_ENV,
  GATEWAY_POOL_MAX,
  GENERATOR_POOL_MAX,
  LISTEN_CONNECTIONS_PER_ADMIN_INSTANCE,
  type PoolBudgetInput,
  poolBudgetEnv,
} from "./pool-budget.js";

const GCP_DEFAULT: PoolBudgetInput = {
  maxConnections: 100,
  adminMaxInstances: 5,
  gatewayMaxInstances: 10,
  concurrentBuilds: 2,
  maintenanceReserve: 5,
  migrationsReserve: 2,
  jobsReserve: 4,
};

describe("computePoolBudget", () => {
  it("splits what the reserves leave across the admin instances", () => {
    const b = computePoolBudget(GCP_DEFAULT);
    // 100 - (5 + 2 + 4 + 8 + 20 + 5 + 10 + 20) = 26 → floor(26 / 5) = 5, 1 left.
    expect(b.adminPoolMax).toBe(5);
    expect(b.unassigned).toBe(1);
    expect(b.adminPublicPoolMax).toBe(ADMIN_PUBLIC_POOL_MAX);
    expect(b.gatewayPoolMax).toBe(GATEWAY_POOL_MAX);
    expect(b.generatorPoolMax).toBe(GENERATOR_POOL_MAX);
  });

  it("never hands out more than max_connections at full scale-out", () => {
    for (const maxConnections of [60, 100, 250, 429]) {
      for (const adminMaxInstances of [1, 3, 5]) {
        const input = { ...GCP_DEFAULT, maxConnections, adminMaxInstances };
        let b: ReturnType<typeof computePoolBudget>;
        try {
          b = computePoolBudget(input);
        } catch {
          continue;
        }
        const reserved = b.reserves.reduce((s, r) => s + r.connections, 0);
        expect(reserved + b.adminPoolMax * adminMaxInstances + b.unassigned).toBe(maxConnections);
      }
    }
  });

  it("names a LISTEN reserve of one connection per admin instance (#1267)", () => {
    const listen = computePoolBudget(GCP_DEFAULT).reserves.find((r) => r.name === "listen");
    expect(LISTEN_CONNECTIONS_PER_ADMIN_INSTANCE).toBe(1);
    expect(listen?.connections).toBe(GCP_DEFAULT.adminMaxInstances);
  });

  it("budgets the gateway and the generator from their instance counts", () => {
    const r = new Map(computePoolBudget(GCP_DEFAULT).reserves.map((x) => [x.name, x.connections]));
    expect(r.get("gateway")).toBe(10 * GATEWAY_POOL_MAX);
    expect(r.get("generator")).toBe(2 * 2 * GENERATOR_POOL_MAX);
    expect(r.get("admin-public")).toBe(5 * ADMIN_PUBLIC_POOL_MAX);
  });

  it("refuses a budget below the admin floor, naming the connections needed", () => {
    // The pre-#1254 GCP shape: 100 gateway instances can never fit 100 slots.
    expect(() => computePoolBudget({ ...GCP_DEFAULT, gatewayMaxInstances: 100 })).toThrow(
      /Raise maxConnections to at least 364/,
    );
    expect(() => computePoolBudget({ ...GCP_DEFAULT, maxConnections: 50 })).toThrow(
      new RegExp(`minimum of ${ADMIN_POOL_FLOOR}`),
    );
  });

  it("accepts exactly the floor", () => {
    // reserves 74 + 5 × 4 = 94.
    expect(computePoolBudget({ ...GCP_DEFAULT, maxConnections: 94 }).adminPoolMax).toBe(4);
    expect(() => computePoolBudget({ ...GCP_DEFAULT, maxConnections: 93 })).toThrow();
  });

  it("rejects malformed input instead of guessing", () => {
    expect(() => computePoolBudget({ ...GCP_DEFAULT, adminMaxInstances: 0 })).toThrow(
      /adminMaxInstances/,
    );
    expect(() => computePoolBudget({ ...GCP_DEFAULT, maxConnections: Number.NaN })).toThrow(
      /maxConnections/,
    );
    expect(() => computePoolBudget({ ...GCP_DEFAULT, jobsReserve: -1 })).toThrow(/jobsReserve/);
  });
});

describe("poolBudgetEnv", () => {
  const b = computePoolBudget(GCP_DEFAULT);

  it("sizes both admin pools", () => {
    expect(poolBudgetEnv(b, "admin")).toEqual([
      { name: DB_POOL_MAX_ENV, value: "5" },
      { name: DB_PUBLIC_POOL_MAX_ENV, value: String(ADMIN_PUBLIC_POOL_MAX) },
    ]);
  });

  it("sizes the gateway's only (cms_public) pool", () => {
    expect(poolBudgetEnv(b, "gateway")).toEqual([
      { name: DB_PUBLIC_POOL_MAX_ENV, value: String(GATEWAY_POOL_MAX) },
    ]);
  });
});
