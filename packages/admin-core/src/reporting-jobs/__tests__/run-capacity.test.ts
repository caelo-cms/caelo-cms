// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { PERFORMANCE_RUNS, QUALITY_AUDIT_PAGE_CAP } from "../../ops/quality/lifecycle.js";
import type { GoogleDeps } from "../../security/operator-access/google-iam.js";
import { MAX_LIGHTHOUSE_TASKS, readRunQuota, regionQuotaVcpu } from "../run-capacity.js";

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

describe("the Lighthouse runs of one batch", () => {
  it("cover one full batch of the quality check: its pages times its runs", () => {
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

describe("readRunQuota", () => {
  it("asks Service Usage for the job's project and reads its region", async () => {
    const deps = google(
      200,
      answer([{ effectiveLimit: "20000", dimensions: { region: "europe-west1" } }]),
    );
    expect(await readRunQuota(JOB, deps)).toEqual({
      projectId: "acme",
      region: "europe-west1",
      quotaVcpu: 20,
    });
    expect(deps.urls).toEqual([
      "https://serviceusage.googleapis.com/v1beta1/projects/acme/services/run.googleapis.com/consumerQuotaMetrics/run.googleapis.com%2Fcpu_allocation",
    ]);
  });

  it("names the missing grant and the fix when Google refuses", async () => {
    await expect(
      readRunQuota(JOB, google(403, { error: { message: "Permission denied" } })),
    ).rejects.toThrow(/serviceusage\.serviceUsageViewer.*cms-provision upgrade/);
  });

  it("refuses a value that is not a job name", async () => {
    await expect(readRunQuota("caelo-production-index", google(200, {}))).rejects.toThrow(
      /not a Cloud Run job name/,
    );
  });
});
