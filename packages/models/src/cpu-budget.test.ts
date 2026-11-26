// SPDX-License-Identifier: MPL-2.0

/**
 * The embedder's thread count follows the container's CPU quota rounded up.
 * Cloud Run gave the 2-vCPU index job quotas of 1.61 and 1.97 CPUs, and
 * `os.availableParallelism()` (rounding down) made it embed on one thread.
 */

import { describe, expect, it } from "bun:test";
import { type CpuSources, cpuBudget } from "./cpu-budget.js";

const sources = (files: Record<string, string>, hostCpus = 5, available = 1): CpuSources => ({
  readFile: (path) => files[path] ?? null,
  hostCpus,
  available,
});

describe("cpuBudget", () => {
  it("rounds a cgroup v1 quota just under two CPUs up to two", () => {
    const v1 = (quota: string) =>
      sources({
        "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": `${quota}\n`,
        "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000\n",
      });
    expect(cpuBudget(v1("161300"))).toBe(2);
    expect(cpuBudget(v1("197200"))).toBe(2);
    expect(cpuBudget(v1("200000"))).toBe(2);
    expect(cpuBudget(v1("50000"))).toBe(1);
  });

  it("reads cgroup v2's cpu.max, and an unlimited one falls back to the runtime's answer", () => {
    expect(cpuBudget(sources({ "/sys/fs/cgroup/cpu.max": "400000 100000\n" }))).toBe(4);
    expect(cpuBudget(sources({ "/sys/fs/cgroup/cpu.max": "max 100000\n" }, 8, 8))).toBe(8);
  });

  it("never exceeds the host's CPUs, and without a cgroup uses the runtime's answer", () => {
    expect(cpuBudget(sources({ "/sys/fs/cgroup/cpu.max": "800000 100000" }, 2))).toBe(2);
    expect(cpuBudget(sources({}, 12, 11))).toBe(11);
    expect(cpuBudget(sources({ "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "-1" }, 4, 4))).toBe(4);
  });
});
