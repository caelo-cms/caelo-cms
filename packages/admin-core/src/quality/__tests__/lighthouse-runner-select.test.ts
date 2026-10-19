// SPDX-License-Identifier: MPL-2.0

/**
 * #875 — which Lighthouse runner an install gets. The load-bearing rule:
 * a cloud install never falls back to the in-process runner (its runs
 * would share the admin's CPU and measure it); a missing audit job fails
 * every audit with the fix instead (no fallbacks pre-1.0).
 */

import { describe, expect, it } from "bun:test";
import type { AuditJob } from "../lighthouse-protocol.js";
import { runAuditJob } from "../lighthouse-runner.js";
import { lighthouseRunnerFromEnv } from "../lighthouse-runner-select.js";

const JOB: AuditJob = {
  pages: [{ pageId: "00000000-0000-4000-8000-000000000001", url: "https://s.example/" }],
  performanceRuns: 3,
};

describe("lighthouseRunnerFromEnv", () => {
  it("keeps the in-process child on self-hosted and dev installs", () => {
    expect(lighthouseRunnerFromEnv({ CAELO_PROVIDER: "self-hosted" })).toBe(runAuditJob);
    expect(lighthouseRunnerFromEnv({})).toBe(runAuditJob);
  });

  it("fans GCP audits out to the audit job", () => {
    for (const provider of ["gcp", "gcp-firebase"]) {
      const runner = lighthouseRunnerFromEnv({
        CAELO_PROVIDER: provider,
        CAELO_AUDIT_JOB: "projects/acme/locations/europe-west1/jobs/caelo-production-audit",
        CAELO_AUDIT_RESULTS_BUCKET: "acme-caelo-production-audit-results",
      });
      expect(runner).not.toBe(runAuditJob);
    }
  });

  it("fails every GCP audit with the fix when the job is not configured, never runs in-process", async () => {
    const runner = lighthouseRunnerFromEnv({ CAELO_PROVIDER: "gcp" });
    expect(runner).not.toBe(runAuditJob);
    const r = await runner(JOB);
    expect(r).toMatchObject({
      ok: false,
      failure: { code: "child-failed", message: expect.stringContaining("cms-provision upgrade") },
    });
  });

  it("fails every AWS / Azure audit with the tracked gap", async () => {
    for (const [provider, issue] of [
      ["aws", "#749"],
      ["azure", "#750"],
    ] as const) {
      const r = await lighthouseRunnerFromEnv({ CAELO_PROVIDER: provider })(JOB);
      expect(r).toMatchObject({
        ok: false,
        failure: { code: "child-failed", message: expect.stringContaining(issue) },
      });
    }
  });
});
