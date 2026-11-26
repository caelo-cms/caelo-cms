// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { PERFORMANCE_RUNS, QUALITY_AUDIT_PAGE_CAP } from "../../ops/quality/lifecycle.js";
import type { GoogleDeps } from "../../security/operator-access/google-iam.js";
import { MAX_JOB_TASKS } from "../protocol.js";
import {
  capacityLimited,
  INDEX_TASK_VCPU,
  LIGHTHOUSE_TASK_VCPU,
  MAX_LIGHTHOUSE_TASKS,
  planRunCapacity,
  RESERVED_VCPU,
  readRunCapacity,
  regionQuotaVcpu,
  runCapacitySchema,
} from "../run-capacity.js";

const JOB = "projects/acme/locations/europe-west1/jobs/caelo-production-index";

/** Google's answer for `run.googleapis.com/cpu_allocation`, as a real project returns it. */
function answer(buckets: { effectiveLimit: string; dimensions?: Record<string, string> }[]) {
  return {
    name: "projects/1/services/run.googleapis.com/consumerQuotaMetrics/run.googleapis.com%2Fcpu_allocation",
    displayName: "Total CPU allocation",
    consumerQuotaLimits: [
      {
        name: "…/limits/%2Fmin%2Fproject%2Fregion",
        unit: "1/min/{project}/{region}",
        metric: "run.googleapis.com/cpu_allocation",
        quotaBuckets: buckets,
      },
    ],
  };
}

function google(status: number, body: unknown): GoogleDeps & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    accessToken: async () => "token",
    metadata: async () => "",
    fetch: (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch,
  };
}

describe("planRunCapacity", () => {
  it("fits a new project's 20 vCPU: the reserve stays free, the check gets the rest after one index task", () => {
    const c = planRunCapacity("acme", "europe-west1", 20);
    expect(c.lighthouseTasks).toBe(5);
    expect(c.indexTasks).toBe(1);
    // Both together never reach into the reserve.
    expect(
      RESERVED_VCPU + c.lighthouseTasks * LIGHTHOUSE_TASK_VCPU + c.indexTasks * INDEX_TASK_VCPU,
    ).toBeLessThanOrEqual(20);
    expect(capacityLimited(c)).toBe(true);
  });

  it("never lets both jobs together exceed a quota that holds the reserve and two tasks", () => {
    for (let quota = RESERVED_VCPU + 4; quota <= 120; quota += 1) {
      const c = planRunCapacity("acme", "europe-west1", quota);
      expect(
        RESERVED_VCPU + c.lighthouseTasks * LIGHTHOUSE_TASK_VCPU + c.indexTasks * INDEX_TASK_VCPU,
      ).toBeLessThanOrEqual(quota);
    }
  });

  it("runs every Lighthouse run at once from the check's full-speed quota, and the index next to it above", () => {
    const check = planRunCapacity("acme", "europe-west1", 40);
    expect(check.checkFullSpeedVcpu).toBe(40);
    expect(check.lighthouseTasks).toBe(MAX_LIGHTHOUSE_TASKS);
    expect(check.indexTasks).toBe(1);
    const full = planRunCapacity("acme", "europe-west1", check.fullSpeedVcpu);
    expect(full.fullSpeedVcpu).toBe(102);
    expect(full.lighthouseTasks).toBe(MAX_LIGHTHOUSE_TASKS);
    expect(full.indexTasks).toBe(MAX_JOB_TASKS);
    expect(capacityLimited(full)).toBe(false);
  });

  it("caps an old project's thousands of vCPU, and a project without a limit, at the full width", () => {
    for (const quota of [3000, null]) {
      const c = planRunCapacity("acme", "europe-west1", quota);
      expect([c.lighthouseTasks, c.indexTasks]).toEqual([MAX_LIGHTHOUSE_TASKS, MAX_JOB_TASKS]);
    }
  });

  it("still runs one task of each below the reserve instead of none", () => {
    const c = planRunCapacity("acme", "europe-west1", 4);
    expect([c.lighthouseTasks, c.indexTasks]).toEqual([1, 1]);
  });

  it("is what an order carries", () => {
    expect(runCapacitySchema.parse(planRunCapacity("acme", "europe-west1", 20))).toBeTruthy();
  });

  it("covers one full batch of the quality check: its pages times its runs", () => {
    expect(MAX_LIGHTHOUSE_TASKS).toBe(QUALITY_AUDIT_PAGE_CAP * PERFORMANCE_RUNS);
  });
});

describe("regionQuotaVcpu", () => {
  it("reads the region's own bucket in milli vCPU", () => {
    const a = answer([
      { effectiveLimit: "500000" },
      { effectiveLimit: "20000", dimensions: { region: "europe-west1" } },
    ]);
    expect(regionQuotaVcpu(a, "europe-west1")).toBe(20);
  });

  it("takes the bucket without dimensions for a region without one of its own", () => {
    const a = answer([
      { effectiveLimit: "500000" },
      { effectiveLimit: "20000", dimensions: { region: "europe-west1" } },
    ]);
    expect(regionQuotaVcpu(a, "us-central1")).toBe(500);
  });

  it("reads -1 as no limit", () => {
    expect(regionQuotaVcpu(answer([{ effectiveLimit: "-1" }]), "europe-west1")).toBeNull();
  });

  it("throws on an answer without a regional limit instead of assuming one", () => {
    expect(() => regionQuotaVcpu({ consumerQuotaLimits: [] }, "europe-west1")).toThrow(
      /no per-region limit/,
    );
    expect(() =>
      regionQuotaVcpu(
        answer([{ effectiveLimit: "1000", dimensions: { region: "asia-east1" } }]),
        "europe-west1",
      ),
    ).toThrow(/no limit for region europe-west1/);
  });
});

describe("readRunCapacity", () => {
  it("asks Service Usage for the job's project and plans for its region", async () => {
    const deps = google(
      200,
      answer([{ effectiveLimit: "20000", dimensions: { region: "europe-west1" } }]),
    );
    const c = await readRunCapacity(JOB, deps);
    expect(deps.urls).toEqual([
      "https://serviceusage.googleapis.com/v1beta1/projects/acme/services/run.googleapis.com/consumerQuotaMetrics/run.googleapis.com%2Fcpu_allocation",
    ]);
    expect([c.projectId, c.region, c.quotaVcpu, c.lighthouseTasks]).toEqual([
      "acme",
      "europe-west1",
      20,
      5,
    ]);
  });

  it("names the missing grant and the fix when Google refuses", async () => {
    await expect(
      readRunCapacity(JOB, google(403, { error: { message: "Permission denied" } })),
    ).rejects.toThrow(/serviceusage\.serviceUsageViewer.*cms-provision upgrade/);
  });

  it("refuses a value that is not a job name", async () => {
    await expect(readRunCapacity("caelo-production-index", google(200, {}))).rejects.toThrow(
      /not a Cloud Run job name/,
    );
  });
});
