// SPDX-License-Identifier: MPL-2.0

/**
 * Cloud Run CPU allocation. A missing `cpuIdle` in the v2 API means
 * always-on CPU once `resources` is set, so both stacks ran the admin and
 * the gateway billed around the clock. The stacks now set it from
 * SERVICE_CPU_IDLE, and an upgrade moves existing installs there.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SERVICE_CPU_IDLE } from "./stack-contract.js";
import { liveCpuIdle, planCpuIdle } from "./stack-converge.js";

const described = (annotations?: Record<string, string>) =>
  JSON.stringify({ spec: { template: { metadata: annotations ? { annotations } : {} } } });

describe("liveCpuIdle", () => {
  it("reads the revision's cpu-throttling annotation", () => {
    expect(liveCpuIdle(described({ "run.googleapis.com/cpu-throttling": "false" }))).toBe(false);
    expect(liveCpuIdle(described({ "run.googleapis.com/cpu-throttling": "true" }))).toBe(true);
  });

  it("treats a missing annotation as Cloud Run's default, request-based CPU", () => {
    expect(liveCpuIdle(described())).toBe(true);
    expect(liveCpuIdle(described({ "autoscaling.knative.dev/maxScale": "5" }))).toBe(true);
  });
});

describe("planCpuIdle", () => {
  it("moves an always-on service to request-based CPU", () => {
    expect(planCpuIdle(false, true)).toEqual({
      ok: true,
      flags: ["--cpu-throttling"],
      changes: ["CPU: always allocated → only during requests"],
    });
  });

  it("changes nothing when the service already matches", () => {
    expect(planCpuIdle(true, true)).toEqual({ ok: true, flags: [], changes: [] });
    expect(planCpuIdle(false, false)).toEqual({ ok: true, flags: [], changes: [] });
  });

  it("never switches a service to always-on CPU", () => {
    expect(planCpuIdle(true, false)).toEqual({ ok: true, flags: [], changes: [] });
  });
});

describe("the stacks set cpuIdle", () => {
  it("the gateway runs request-billed", () => {
    expect(SERVICE_CPU_IDLE.gateway).toBe(true);
  });

  for (const provider of ["gcp", "gcp-firebase"]) {
    it(`${provider} takes cpuIdle from the contract`, () => {
      const stack = readFileSync(
        resolve(import.meta.dir, `../stacks/${provider}/index.ts`),
        "utf8",
      );
      expect(stack).toContain("cpuIdle: SERVICE_CPU_IDLE[args.serviceName]");
    });
  }
});
