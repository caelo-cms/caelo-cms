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
 */

import { describe, expect, it } from "bun:test";
import { reportingJobKinds } from "../packages/admin-core/src/reporting-jobs/kinds.js";
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
});
