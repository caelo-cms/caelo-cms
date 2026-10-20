// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { GoogleDeps } from "../../security/operator-access/google-iam.js";
import type { AuditTaskBatch } from "../audit-task-protocol.js";
import { executionProgress, gcpAuditLauncher } from "../gcp-audit-launcher.js";
import { runAuditJob } from "../lighthouse-runner.js";
import { lighthouseRunnerFromEnv } from "../lighthouse-runner-select.js";

const JOB = "projects/acme/locations/europe-west1/jobs/caelo-production-audit";

function fakeGoogle(answer: (url: string, body: unknown) => unknown) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const deps: GoogleDeps = {
    accessToken: async () => "token",
    metadata: async () => "",
    fetch: (async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, method: init?.method ?? "GET", body });
      return new Response(JSON.stringify(answer(url, body)), { status: 200 });
    }) as typeof fetch,
  };
  return { deps, calls };
}

const batch: AuditTaskBatch = {
  version: "1.2.3",
  orders: [
    {
      jobId: "00000000-0000-4000-8000-000000000001",
      taskId: "p0-r0",
      pageId: "00000000-0000-4000-8000-0000000000aa",
      url: "https://preview.example/",
      categories: "all",
      resultKey: "00000000-0000-4000-8000-000000000001/p0-r0.json",
    },
  ],
};

describe("gcpAuditLauncher", () => {
  it("runs ONE execution with one task per order and the batch as env override", async () => {
    const { deps, calls } = fakeGoogle(() => ({
      metadata: { name: `${JOB}/executions/caelo-production-audit-x1` },
    }));
    const launcher = gcpAuditLauncher(JOB, { read: async () => null, write: async () => {} }, deps);
    const handle = await launcher.start({ ...batch, orders: [...batch.orders, ...batch.orders] });
    expect(handle).toBe(`${JOB}/executions/caelo-production-audit-x1`);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`https://run.googleapis.com/v2/${JOB}:run`);
    const overrides = (calls[0] as { body: { overrides: Record<string, unknown> } }).body.overrides;
    expect(overrides.taskCount).toBe(2);
    expect(overrides.timeout).toBe("300s");
    expect(overrides.containerOverrides).toEqual([
      {
        env: [
          {
            name: "CAELO_AUDIT_TASK",
            value: JSON.stringify({ ...batch, orders: [...batch.orders, ...batch.orders] }),
          },
        ],
      },
    ]);
  });

  it("refuses a value that is not a Cloud Run job name", () => {
    expect(() =>
      gcpAuditLauncher("caelo-production-audit", { read: async () => null, write: async () => {} }),
    ).toThrow(/not a Cloud Run job name/);
  });
});

describe("executionProgress", () => {
  it("is running until every task ended", () => {
    expect(executionProgress({ taskCount: 3, succeededCount: 2 })).toEqual({
      failed: 0,
      finished: false,
    });
    expect(executionProgress({ taskCount: 3, succeededCount: 3 })).toEqual({
      failed: 0,
      finished: true,
    });
  });

  it("counts failed and cancelled tasks", () => {
    expect(
      executionProgress({ taskCount: 3, succeededCount: 1, failedCount: 1, cancelledCount: 1 }),
    ).toEqual({
      failed: 2,
      finished: true,
    });
  });

  it("is finished once Cloud Run stamped a completion time", () => {
    expect(executionProgress({ completionTime: "2026-10-19T10:00:00Z" }).finished).toBe(true);
  });
});

describe("lighthouseRunnerFromEnv", () => {
  it("keeps the in-process child on self-hosted and dev", () => {
    expect(lighthouseRunnerFromEnv({ CAELO_PROVIDER: "self-hosted" })).toBe(runAuditJob);
    expect(lighthouseRunnerFromEnv({})).toBe(runAuditJob);
  });

  it("fails every audit with the fix when a cloud install has no audit job — never in-process", async () => {
    const run = lighthouseRunnerFromEnv({ CAELO_PROVIDER: "gcp" });
    const result = await run({ pages: [], performanceRuns: 3 } as never);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).toContain("cms-provision upgrade");
  });

  it("names a provider that has no parallel audit job yet", async () => {
    const result = await lighthouseRunnerFromEnv({ CAELO_PROVIDER: "aws" })({
      pages: [],
      performanceRuns: 3,
    } as never);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).toContain('provider "aws"');
  });
});
