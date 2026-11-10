// SPDX-License-Identifier: MPL-2.0

/**
 * #1359 — a reporting job's setup (reporting-job-setup.ts) against a fake
 * gcloud. The load-bearing assertions are the trust boundary: the
 * quality-audit runner's service account may sign its own IAP credential,
 * pass the admin's IAP, write logs, read the staged build and the
 * Lighthouse results, and start the Lighthouse job — no secret, no
 * database, no other IAM or run right, no VPC — and the admin may run the
 * runner with overrides and read its executions, nothing else.
 */

import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { GcloudResult } from "./gcloud.js";
import {
  auditRunnerJobSpec,
  ensureAuditRunnerJob,
  ensureImportCrawlJob,
  importCrawlJobSpec,
  REPORTING_JOB_FORBIDDEN_ROLES,
  REPORTING_JOB_SCRIPT,
  type ReportingJobTarget,
} from "./reporting-job-setup.js";

const ok = (stdout = ""): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });

const RUNNER_SA = "caelo-production-audit-run@acme.iam.gserviceaccount.com";
const RUNNER = `serviceAccount:${RUNNER_SA}`;
const ADMIN_SA = "serviceAccount:caelo-production-run-sa@acme.iam.gserviceaccount.com";
const ADMIN_IMAGE = `europe-west1-docker.pkg.dev/caelo-website/caelo-cms-images/admin@sha256:${"a".repeat(64)}`;

const TARGET: ReportingJobTarget = {
  provider: "gcp",
  projectId: "acme",
  region: "europe-west1",
  env: "production",
  adminImageRef: ADMIN_IMAGE,
  resource: { kind: "backend-services", service: "caelo-production-admin-backend-1a2b" },
};

function fakeGcloud(overrides: [RegExp, GcloudResult][] = []) {
  const calls: string[][] = [];
  const rules: [RegExp, GcloudResult][] = [
    ...overrides,
    [/^iam service-accounts describe/, fail("NOT_FOUND")],
  ];
  const run = async (args: string[]) => {
    calls.push(args);
    const line = args.join(" ");
    return rules.find(([re]) => re.test(line))?.[1] ?? ok("");
  };
  return { run, calls };
}

const flag = (args: string[], name: string) =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

/** Every IAM grant the setup made, as {where, member, role}. */
function grants(calls: string[][]) {
  return calls
    .filter((c) => c.includes("add-iam-policy-binding"))
    .map((c) => ({
      where: c.slice(0, c.indexOf("add-iam-policy-binding") + 2).join(" "),
      member: flag(c, "member"),
      role: flag(c, "role") as string,
    }));
}

const deployOf = (calls: string[][]) =>
  calls.find((c) => c[0] === "run" && c[1] === "jobs" && c[2] === "deploy") as string[];

describe("ensureAuditRunnerJob (#1359)", () => {
  it("creates the runner's own account and grants it exactly its line", async () => {
    const { run, calls } = fakeGcloud();
    const r = await ensureAuditRunnerJob(TARGET, { run, sleep: async () => {} });
    expect(r.ok).toBe(true);
    expect(
      calls.some((c) =>
        c.join(" ").startsWith("iam service-accounts create caelo-production-audit-run "),
      ),
    ).toBe(true);
    const mine = grants(calls).filter((g) => g.member === RUNNER);
    expect(mine.map((g) => [g.where, g.role])).toEqual([
      // Signs its own IAP credential, nobody else's.
      [
        `iam service-accounts add-iam-policy-binding ${RUNNER_SA}`,
        "roles/iam.serviceAccountTokenCreator",
      ],
      ["projects add-iam-policy-binding acme", "roles/logging.logWriter"],
      [
        "iap web add-iam-policy-binding --resource-type=backend-services",
        "roles/iap.httpsResourceAccessor",
      ],
      [
        "storage buckets add-iam-policy-binding gs://acme-caelo-production-staging",
        "roles/storage.objectViewer",
      ],
      [
        "storage buckets add-iam-policy-binding gs://acme-caelo-production-audit-results",
        "roles/storage.objectViewer",
      ],
      // Run rights only on the Lighthouse job it starts.
      [
        "run jobs add-iam-policy-binding caelo-production-audit",
        "roles/run.jobsExecutorWithOverrides",
      ],
      ["run jobs add-iam-policy-binding caelo-production-audit", "roles/run.viewer"],
    ]);
    for (const g of mine) {
      for (const forbidden of REPORTING_JOB_FORBIDDEN_ROLES) {
        expect(g.role.startsWith(forbidden)).toBe(false);
      }
    }
  });

  it("passes IAP on the admin's own resource, the Cloud Run service on gcp-firebase", async () => {
    const { run, calls } = fakeGcloud();
    await ensureAuditRunnerJob(
      {
        ...TARGET,
        provider: "gcp-firebase",
        resource: {
          kind: "cloud-run",
          service: "caelo-production-admin-x",
          region: "europe-west1",
        },
      },
      { run, sleep: async () => {} },
    );
    const iap = calls.find((c) => c.slice(0, 3).join(" ") === "iap web add-iam-policy-binding");
    expect(iap).toContain("--resource-type=cloud-run");
    expect(iap).toContain("--service=caelo-production-admin-x");
    expect(iap).toContain("--region=europe-west1");
  });

  it("gives the admin run-with-overrides and view on the runner, nothing else", async () => {
    const { run, calls } = fakeGcloud();
    await ensureAuditRunnerJob(TARGET, { run, sleep: async () => {} });
    expect(
      grants(calls)
        .filter((g) => g.member === ADMIN_SA)
        .map((g) => [g.where, g.role]),
    ).toEqual([
      [
        "run jobs add-iam-policy-binding caelo-production-audit-run",
        "roles/run.jobsExecutorWithOverrides",
      ],
      ["run jobs add-iam-policy-binding caelo-production-audit-run", "roles/run.viewer"],
    ]);
  });

  it("deploys the admin image as its own SA: no secret, no database, no VPC, no Cloud Run retry", async () => {
    const { run, calls } = fakeGcloud();
    await ensureAuditRunnerJob(TARGET, { run, sleep: async () => {} });
    const deploy = deployOf(calls);
    expect(deploy.slice(0, 4)).toEqual(["run", "jobs", "deploy", "caelo-production-audit-run"]);
    expect(flag(deploy, "image")).toBe(ADMIN_IMAGE);
    expect(flag(deploy, "service-account")).toBe(RUNNER_SA);
    expect(flag(deploy, "command")).toBe("bun");
    expect(flag(deploy, "args")).toBe(`--bun,${REPORTING_JOB_SCRIPT}`);
    // A dead attempt is restarted by the tick's backstop with a new token.
    expect(flag(deploy, "max-retries")).toBe("0");
    expect(flag(deploy, "task-timeout")).toBe("3600s");
    const env = flag(deploy, "set-env-vars") ?? "";
    expect(env.split(",").sort()).toEqual(
      [
        "CAELO_PROVIDER=gcp",
        "CAELO_STAGING_BUCKET=acme-caelo-production-staging",
        "CAELO_AUDIT_JOB=projects/acme/locations/europe-west1/jobs/caelo-production-audit",
        "CAELO_AUDIT_RESULTS_BUCKET=acme-caelo-production-audit-results",
      ].sort(),
    );
    expect(env).not.toMatch(/DATABASE|PASSWORD|SECRET|KEK/);
    for (const a of deploy) {
      expect(a).not.toMatch(/^--(set|update)-secrets|^--(vpc-connector|network|subnet|vpc-egress)/);
    }
  });

  it("points the job at an entry point the admin image ships", () => {
    // The image copies the repo's packages/ to /app/packages (apps/admin/Dockerfile).
    const repoRoot = join(import.meta.dir, "..", "..", "..");
    expect(REPORTING_JOB_SCRIPT.startsWith("/app/packages/")).toBe(true);
    expect(existsSync(join(repoRoot, REPORTING_JOB_SCRIPT.slice("/app/".length)))).toBe(true);
  });

  it("refuses an image not pinned by digest, before any change", async () => {
    const { run, calls } = fakeGcloud();
    const r = await ensureAuditRunnerJob(
      { ...TARGET, adminImageRef: "ghcr.io/caelo-cms/admin:latest" },
      { run, sleep: async () => {} },
    );
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("stops at the first failed grant and says which", async () => {
    const { run, calls } = fakeGcloud([
      [
        /^iap web add-iam-policy-binding/,
        fail("PERMISSION_DENIED: iap.webServiceVersions.setIamPolicy"),
      ],
    ]);
    const r = await ensureAuditRunnerJob(TARGET, { run, sleep: async () => {} });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("pass the admin's IAP");
    expect(deployOf(calls)).toBeUndefined();
  });

  it("keeps an existing account (describe succeeds) and does not create it twice", async () => {
    const { run, calls } = fakeGcloud([[/^iam service-accounts describe/, ok(`${RUNNER_SA}\n`)]]);
    const r = await ensureAuditRunnerJob(TARGET, { run, sleep: async () => {} });
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c.slice(0, 3).join(" ") === "iam service-accounts create")).toBe(
      false,
    );
  });

  it("names the staging slot, the results and the Lighthouse job of the install it is for", () => {
    const spec = auditRunnerJobSpec({ ...TARGET, provider: "gcp-firebase" });
    expect(spec.env).toContain("CAELO_PROVIDER=gcp-firebase");
    expect(spec.readBuckets.map((b) => b.bucket)).toEqual([
      "acme-caelo-production-staging",
      "acme-caelo-production-audit-results",
    ]);
    expect(spec.runJobs.map((j) => j.job)).toEqual(["caelo-production-audit"]);
  });
});

describe("ensureImportCrawlJob (#1360)", () => {
  const CRAWLER_SA = "caelo-production-import@acme.iam.gserviceaccount.com";
  const CRAWLER = `serviceAccount:${CRAWLER_SA}`;

  it("grants the crawler the shared line and nothing else: no bucket, no other job", async () => {
    const { run, calls } = fakeGcloud();
    const r = await ensureImportCrawlJob(TARGET, { run, sleep: async () => {} });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.serviceAccount).toBe(CRAWLER_SA);
    expect(
      calls.some((c) =>
        c.join(" ").startsWith("iam service-accounts create caelo-production-import "),
      ),
    ).toBe(true);
    const mine = grants(calls).filter((g) => g.member === CRAWLER);
    expect(mine.map((g) => [g.where, g.role])).toEqual([
      // Signs its own IAP credential, nobody else's.
      [
        `iam service-accounts add-iam-policy-binding ${CRAWLER_SA}`,
        "roles/iam.serviceAccountTokenCreator",
      ],
      ["projects add-iam-policy-binding acme", "roles/logging.logWriter"],
      [
        "iap web add-iam-policy-binding --resource-type=backend-services",
        "roles/iap.httpsResourceAccessor",
      ],
    ]);
    for (const g of mine) {
      for (const forbidden of REPORTING_JOB_FORBIDDEN_ROLES) {
        expect(g.role.startsWith(forbidden)).toBe(false);
      }
      // It reads third-party pages: no run right anywhere, no storage at all.
      expect(g.role.startsWith("roles/run.")).toBe(false);
      expect(g.role.startsWith("roles/storage.")).toBe(false);
    }
  });

  it("gives the admin run-with-overrides and view on the crawler, nothing else", async () => {
    const { run, calls } = fakeGcloud();
    await ensureImportCrawlJob(TARGET, { run, sleep: async () => {} });
    expect(
      grants(calls)
        .filter((g) => g.member === ADMIN_SA)
        .map((g) => [g.where, g.role]),
    ).toEqual([
      [
        "run jobs add-iam-policy-binding caelo-production-import",
        "roles/run.jobsExecutorWithOverrides",
      ],
      ["run jobs add-iam-policy-binding caelo-production-import", "roles/run.viewer"],
    ]);
  });

  it("deploys the admin image as its own SA: no secret, no database, no VPC, no bucket, no Cloud Run retry", async () => {
    const { run, calls } = fakeGcloud();
    await ensureImportCrawlJob(TARGET, { run, sleep: async () => {} });
    const deploy = deployOf(calls);
    expect(deploy.slice(0, 4)).toEqual(["run", "jobs", "deploy", "caelo-production-import"]);
    expect(flag(deploy, "image")).toBe(ADMIN_IMAGE);
    expect(flag(deploy, "service-account")).toBe(CRAWLER_SA);
    expect(flag(deploy, "args")).toBe(`--bun,${REPORTING_JOB_SCRIPT}`);
    expect(flag(deploy, "max-retries")).toBe("0");
    // admin-core JOB_TIMING.site_import.maxRunSeconds.
    expect(flag(deploy, "task-timeout")).toBe("21600s");
    expect(flag(deploy, "set-env-vars")).toBe("CAELO_PROVIDER=gcp");
    for (const a of deploy) {
      expect(a).not.toMatch(/^--(set|update)-secrets|^--(vpc-connector|network|subnet|vpc-egress)/);
    }
  });

  it("asks for no bucket and no job of its own", () => {
    const spec = importCrawlJobSpec({ provider: "gcp-firebase", env: "production" });
    expect(spec.env).toEqual(["CAELO_PROVIDER=gcp-firebase"]);
    expect(spec.readBuckets).toEqual([]);
    expect(spec.runJobs).toEqual([]);
  });
});
