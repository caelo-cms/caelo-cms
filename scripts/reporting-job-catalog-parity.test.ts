// SPDX-License-Identifier: MPL-2.0

/**
 * #1646 — the two halves of a reporting job kind name the same things. The
 * admin (admin-core reporting-jobs/kinds.ts) starts a kind's job on Google
 * Cloud from two env vars, and the provisioning catalog
 * (packages/provisioning/src/reporting-job-catalog.ts) deploys that job and
 * sets those vars. A kind the admin has but the catalog lacks is never
 * deployed (its work fails "no job on this install" on every install); a
 * catalog kind the admin lacks is a job nobody starts, holding IAP access
 * for nothing. Both directions fail here.
 *
 * #1776 — and the same machines: the capacity ledger books the vCPU the
 * admin believes a kind's task has, so a catalog that deploys more would
 * overrun the project's quota unseen, and one that deploys less would
 * leave it idle.
 */

import { describe, expect, it } from "bun:test";
import type { AdminJobDeps } from "../packages/admin-core/src/reporting-jobs/kind.js";
import { reportingJobKinds } from "../packages/admin-core/src/reporting-jobs/kinds.js";
import { BATCH_SIZES } from "../packages/plugin-sdk/src/batch.js";
import { REPORTING_JOB_CATALOG } from "../packages/provisioning/src/reporting-job-catalog.js";

describe("reporting job kinds: admin-core and the provisioning catalog", () => {
  const admin = reportingJobKinds().map((k) => ({
    kind: k.kind,
    jobEnvVar: k.gcp.jobEnvVar,
    serviceAccountEnvVar: k.gcp.serviceAccountEnvVar,
  }));
  const catalog = REPORTING_JOB_CATALOG.map((e) => ({
    kind: e.kind,
    jobEnvVar: e.jobEnvVar,
    serviceAccountEnvVar: e.serviceAccountEnvVar,
  }));
  const byKind = <T extends { kind: string }>(xs: T[]) =>
    [...xs].sort((a, b) => a.kind.localeCompare(b.kind));

  it("declare the same kinds with the same env var names", () => {
    expect(byKind(catalog)).toEqual(byKind(admin));
  });

  it("#1776 — name the same larger machines, with the env vars the admin starts them by", () => {
    const adminSizes = reportingJobKinds().flatMap((k) =>
      Object.entries(k.gcp.sizedJobEnvVars ?? {}).map(([size, env]) => `${k.kind} ${size} ${env}`),
    );
    const catalogSizes = REPORTING_JOB_CATALOG.flatMap((e) =>
      (e.sizes ?? []).map((s) => `${e.kind} ${s.size} ${s.jobEnvVar}`),
    );
    expect(catalogSizes.sort()).toEqual(adminSizes.sort());
  });

  it("#1776 — deploy the vCPU the capacity ledger books for each kind", async () => {
    // Every kind but the plugin batch books a fixed machine; its capacity
    // reads nothing for that.
    const none = {} as AdminJobDeps;
    for (const k of reportingJobKinds()) {
      const entry = REPORTING_JOB_CATALOG.find((e) => e.kind === k.kind);
      if (!entry) throw new Error(`no catalog entry for ${k.kind}`);
      const cpu = Number(
        entry.job({ provider: "gcp", projectId: "p", region: "europe-west1", env: "production" })
          .cpu,
      );
      if (k.kind === "plugin_batch") {
        expect(cpu).toBe(BATCH_SIZES.S.vcpu);
        for (const s of entry.sizes ?? []) {
          expect([Number(s.cpu), s.memory]).toEqual([
            BATCH_SIZES[s.size].vcpu,
            `${BATCH_SIZES[s.size].memoryGiB}Gi`,
          ]);
        }
        continue;
      }
      expect((await k.capacity(none, "00000000-0000-4000-8000-000000000000")).vcpuPerTask).toBe(
        cpu,
      );
    }
  });
});
