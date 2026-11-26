// SPDX-License-Identifier: MPL-2.0

/**
 * How many threads the native embedder gets: the CPUs the container may
 * use, rounded up.
 *
 * `os.availableParallelism()` rounds a fractional CPU quota down. Cloud Run
 * gives a 2-vCPU job a quota just under two (1.61 and 1.97 CPUs, measured
 * on 2026-11-26), so it answered 1 and the index job embedded on one
 * thread: 6 to 8 passages a second, against 10 to 19 with two on the same
 * hosts (bench/semantic-results.md). A thread beyond a fractional quota is
 * not wasted: the kernel throttles the process to its quota, and the
 * second thread is what uses the fraction.
 */

import { readFileSync } from "node:fs";
import { availableParallelism, cpus } from "node:os";

/** Where {@link cpuBudget} looks (tests pass their own). */
export interface CpuSources {
  /** A file's text, or null when it does not exist. */
  readonly readFile: (path: string) => string | null;
  /** The CPUs the host shows. */
  readonly hostCpus: number;
  /** What `os.availableParallelism()` says, for a container without a quota. */
  readonly available: number;
}

function defaultSources(): CpuSources {
  return {
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    hostCpus: cpus().length,
    available: availableParallelism(),
  };
}

/** The CPU quota of the process's cgroup in CPUs (v2, then v1), or null for none. */
export function cgroupCpuQuota(src: CpuSources): number | null {
  const v2 = src.readFile("/sys/fs/cgroup/cpu.max")?.trim().split(/\s+/);
  if (v2 && v2.length === 2) {
    if (v2[0] === "max") return null;
    const [quota, period] = v2.map(Number) as [number, number];
    if (quota > 0 && period > 0) return quota / period;
  }
  const quota = Number(src.readFile("/sys/fs/cgroup/cpu/cpu.cfs_quota_us")?.trim());
  const period = Number(src.readFile("/sys/fs/cgroup/cpu/cpu.cfs_period_us")?.trim());
  if (quota > 0 && period > 0) return quota / period;
  return null;
}

/** Threads for CPU-bound work: the quota rounded up, at most the host's CPUs, at least one. */
export function cpuBudget(src: CpuSources = defaultSources()): number {
  const quota = cgroupCpuQuota(src);
  if (quota === null) return Math.max(1, src.available);
  return Math.max(1, Math.min(src.hostCpus, Math.ceil(quota - 1e-9)));
}
