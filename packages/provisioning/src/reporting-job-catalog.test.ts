// SPDX-License-Identifier: MPL-2.0

/**
 * #1646 — one declaration per kind of reporting job (reporting-job-catalog.ts),
 * and every place that sets up, moves or grants jobs follows it: a kind
 * added to the catalog reaches the admin's env, the app-roll's image move,
 * the upgrader's actAs and its IAM pre-flight without another edit.
 */

import { describe, expect, it } from "bun:test";
import {
  REPORTING_JOB_CATALOG,
  reportingJobAdminEnv,
  reportingJobEntry,
  reportingJobName,
  reportingJobServiceAccountEmail,
  reportingJobServiceAccounts,
  reportingJobSpec,
} from "./reporting-job-catalog.js";
import { adminEnvContract, databaseUrls } from "./stack-contract.js";
import { adminImageJobs } from "./upgrade/admin-image-jobs.js";
import { upgraderAccessChecks } from "./upgrader-iam-preflight.js";
import { upgraderAccountGrants } from "./upgrader-setup.js";

const PLACE = {
  provider: "gcp",
  projectId: "acme",
  region: "europe-west1",
  env: "production",
} as const;

describe("the reporting job catalog", () => {
  it("names each kind, job, account and env var once", () => {
    const unique = (xs: string[]) => expect(new Set(xs).size).toBe(xs.length);
    unique(REPORTING_JOB_CATALOG.map((e) => e.kind));
    unique(REPORTING_JOB_CATALOG.map((e) => e.name));
    unique(REPORTING_JOB_CATALOG.flatMap((e) => [e.jobEnvVar, e.serviceAccountEnvVar]));
    expect(REPORTING_JOB_CATALOG.map((e) => e.kind)).toEqual([
      "quality_audit",
      "site_import",
      "build",
      "collection_index",
      "plugin_batch",
    ]);
  });

  it("keeps every account id within Google's 30 characters, for every stack env", () => {
    for (const env of ["production", "staging", "development"]) {
      for (const e of REPORTING_JOB_CATALOG) {
        const id = reportingJobSpec(e, { ...PLACE, env }).serviceAccountId;
        expect(id.length).toBeLessThanOrEqual(30);
        expect(id).toMatch(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/);
      }
    }
  });

  it("derives the names the kinds had before the catalog", () => {
    expect(REPORTING_JOB_CATALOG.map((e) => reportingJobName(e, "production"))).toEqual([
      "caelo-production-audit-run",
      "caelo-production-import",
      "caelo-production-build",
      "caelo-production-index",
      "caelo-production-plugin-batch",
    ]);
    for (const e of REPORTING_JOB_CATALOG) {
      const spec = reportingJobSpec(e, PLACE);
      expect(spec.jobName).toBe(reportingJobName(e, "production"));
      expect(`${spec.serviceAccountId}@acme.iam.gserviceaccount.com`).toBe(
        reportingJobServiceAccountEmail(e, "acme", "production"),
      );
    }
  });

  it("grants beyond the shared line only what a kind declares, each with a reason", () => {
    const beyond = Object.fromEntries(
      REPORTING_JOB_CATALOG.map((e) => {
        const s = reportingJobSpec(e, PLACE);
        return [
          e.kind,
          {
            read: s.readBuckets.map((b) => b.bucket),
            write: s.writeBuckets.map((b) => b.bucket),
            run: s.runJobs.map((j) => j.job),
          },
        ];
      }),
    );
    expect(beyond).toEqual({
      quality_audit: {
        read: ["acme-caelo-production-staging", "acme-caelo-production-audit-results"],
        write: [],
        run: ["caelo-production-audit"],
      },
      site_import: { read: [], write: [], run: [] },
      build: { read: [], write: [], run: [] },
      collection_index: {
        read: ["acme-caelo-production-coll-staging"],
        write: ["acme-caelo-production-coll-staging"],
        run: [],
      },
      plugin_batch: { read: [], write: [], run: [] },
    });
    for (const e of REPORTING_JOB_CATALOG) {
      const s = reportingJobSpec(e, PLACE);
      for (const g of [...s.readBuckets, ...s.writeBuckets, ...s.runJobs]) {
        expect(g.why.length).toBeGreaterThan(10);
      }
    }
  });

  it("sets each kind up after what it needs", () => {
    expect(reportingJobEntry("quality_audit").prerequisite).toBe("audit-job");
    expect(reportingJobEntry("collection_index").prerequisite).toBe("collection-stores");
    expect(() => reportingJobEntry("nope")).toThrow(/no reporting job kind "nope"/);
  });

  it("reaches the admin's env, the image move, the upgrader's actAs and its pre-flight", () => {
    const env = adminEnvContract({
      provider: "gcp",
      projectId: "acme",
      env: "production",
      domain: "acme.com",
      region: "europe-west1",
      stagingHost: "staging.acme.com",
      databaseUrls: databaseUrls("db1.p-label.europe-west1.sql-psa.goog"),
    });
    const names = env.map((v) => v.name);
    for (const v of reportingJobAdminEnv("acme", "europe-west1", "production")) {
      expect(env).toContainEqual(v);
    }
    // In catalog order, one pair per kind.
    const pairs = REPORTING_JOB_CATALOG.flatMap((e) => [e.jobEnvVar, e.serviceAccountEnvVar]);
    expect(names.filter((n) => pairs.includes(n))).toEqual(pairs);

    const moved = adminImageJobs("production").map((j) => j.name);
    expect(moved.slice(0, 2)).toEqual(["caelo-production-audit", "caelo-production-capture"]);
    expect(moved.slice(2)).toEqual(
      REPORTING_JOB_CATALOG.map((e) => reportingJobName(e, "production")),
    );

    const actAs = upgraderAccountGrants("acme", "production").map((g) => g.account);
    const checked = upgraderAccessChecks({
      projectId: "acme",
      region: "europe-west1",
      env: "production",
    }).flatMap((c) =>
      c.resource.kind === "service-account" && c.permissions.includes("iam.serviceAccounts.actAs")
        ? [c.resource.email]
        : [],
    );
    for (const sa of reportingJobServiceAccounts("acme", "production")) {
      expect(actAs).toContain(sa);
      expect(checked).toContain(sa);
    }
  });
});
