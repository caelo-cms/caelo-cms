// SPDX-License-Identifier: MPL-2.0

/**
 * The quality-audit job's setup (audit-job-setup.ts) against a fake gcloud.
 * The load-bearing assertions are the trust boundary (#875): the job's
 * service account may create results, read the staged build (gcp only) and
 * write logs — no secret, database, IAM or run rights, no VPC — and the
 * admin may run the job with overrides, read its executions and read the
 * results, nothing else.
 */

import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  AUDIT_FORBIDDEN_ROLES,
  AUDIT_PARALLELISM_DEFAULT,
  AUDIT_TASK_SCRIPT,
  type AuditJobTarget,
  ensureAuditJob,
} from "./audit-job-setup.js";
import type { GcloudResult } from "./gcloud.js";

const ok = (stdout = ""): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });

const AUDIT = "serviceAccount:caelo-production-audit@acme.iam.gserviceaccount.com";
const ADMIN_SA = "serviceAccount:caelo-production-run-sa@acme.iam.gserviceaccount.com";
const ADMIN_IMAGE = `europe-west1-docker.pkg.dev/caelo-website/caelo-cms-images/admin@sha256:${"a".repeat(64)}`;
const RESULTS = "acme-caelo-production-audit-results";

const TARGET: AuditJobTarget = {
  provider: "gcp",
  projectId: "acme",
  region: "europe-west1",
  env: "production",
  adminImageRef: ADMIN_IMAGE,
  parallelism: 15,
};

function fakeGcloud(overrides: [RegExp, GcloudResult][] = []) {
  const calls: string[][] = [];
  const rules: [RegExp, GcloudResult][] = [
    ...overrides,
    [/^iam service-accounts describe/, fail("NOT_FOUND")],
    [/^storage buckets list/, ok("gs://acme-caelo-production-static/\n")],
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

describe("ensureAuditJob", () => {
  it("grants the job only results-create, build-read (gcp) and logs", async () => {
    const { run, calls } = fakeGcloud();
    const r = await ensureAuditJob(TARGET, { run, sleep: async () => {} });
    expect(r.ok).toBe(true);
    const job = grants(calls).filter((g) => g.member === AUDIT);
    expect(job.map((g) => [g.where, g.role])).toEqual([
      [`storage buckets add-iam-policy-binding gs://${RESULTS}`, "roles/storage.objectCreator"],
      [
        "storage buckets add-iam-policy-binding gs://acme-caelo-production-staging",
        "roles/storage.objectViewer",
      ],
      [
        "storage buckets add-iam-policy-binding gs://acme-caelo-production-static",
        "roles/storage.objectViewer",
      ],
      ["projects add-iam-policy-binding acme", "roles/logging.logWriter"],
    ]);
    for (const g of job) {
      for (const forbidden of AUDIT_FORBIDDEN_ROLES)
        expect(g.role.startsWith(forbidden)).toBe(false);
    }
  });

  it("gives the admin run-with-overrides and view on the job and read on the results, nothing else", async () => {
    const { run, calls } = fakeGcloud();
    await ensureAuditJob(TARGET, { run, sleep: async () => {} });
    expect(
      grants(calls)
        .filter((g) => g.member === ADMIN_SA)
        .map((g) => [g.where, g.role]),
    ).toEqual([
      [`storage buckets add-iam-policy-binding gs://${RESULTS}`, "roles/storage.objectViewer"],
      [
        "run jobs add-iam-policy-binding caelo-production-audit",
        "roles/run.jobsExecutorWithOverrides",
      ],
      ["run jobs add-iam-policy-binding caelo-production-audit", "roles/run.viewer"],
    ]);
  });

  it("points the job at a task script the admin image ships", () => {
    // The image copies the repo's packages/ to /app/packages (apps/admin/Dockerfile);
    // a moved script would only fail when the first audit starts.
    const repoRoot = join(import.meta.dir, "..", "..", "..");
    expect(AUDIT_TASK_SCRIPT.startsWith("/app/packages/")).toBe(true);
    expect(existsSync(join(repoRoot, AUDIT_TASK_SCRIPT.slice("/app/".length)))).toBe(true);
  });

  it("deploys the admin image as its own SA with no secrets and no VPC", async () => {
    const { run, calls } = fakeGcloud();
    await ensureAuditJob(TARGET, { run, sleep: async () => {} });
    const deploy = deployOf(calls);
    expect(flag(deploy, "image")).toBe(ADMIN_IMAGE);
    expect(flag(deploy, "service-account")).toBe(
      "caelo-production-audit@acme.iam.gserviceaccount.com",
    );
    expect(flag(deploy, "args")).toBe(`--bun,${AUDIT_TASK_SCRIPT}`);
    expect(flag(deploy, "max-retries")).toBe("0");
    expect(flag(deploy, "parallelism")).toBe("15");
    expect(flag(deploy, "set-env-vars")).toBe(
      `CAELO_PROVIDER=gcp,CAELO_AUDIT_RESULTS_BUCKET=${RESULTS},CAELO_STAGING_BUCKET=acme-caelo-production-staging,CAELO_STATIC_BUCKET=acme-caelo-production-static`,
    );
    const line = deploy.join(" ");
    for (const banned of ["--network", "--subnet", "--vpc", "--set-secrets", "--update-secrets"]) {
      expect(line).not.toContain(banned);
    }
  });

  it("creates the private results bucket with a one-day lifecycle when it is missing", async () => {
    const { run, calls } = fakeGcloud();
    await ensureAuditJob(TARGET, { run, sleep: async () => {} });
    const create = calls.find(
      (c) => c.slice(0, 3).join(" ") === "storage buckets create",
    ) as string[];
    expect(create).toContain(`gs://${RESULTS}`);
    expect(create).toContain("--public-access-prevention");
    expect(create).toContain("--uniform-bucket-level-access");
    expect(calls.some((c) => c.join(" ").includes("--lifecycle-file="))).toBe(true);
  });

  it("keeps an existing bucket and an operator's parallelism on converge", async () => {
    const { run, calls } = fakeGcloud([
      [/^storage buckets list/, ok(`gs://${RESULTS}/\n`)],
      [/^run jobs describe caelo-production-audit /, ok(`${ADMIN_IMAGE}\n`)],
    ]);
    const { parallelism: _, ...converge } = TARGET;
    expect((await ensureAuditJob(converge, { run, sleep: async () => {} })).ok).toBe(true);
    expect(calls.some((c) => c.slice(0, 3).join(" ") === "storage buckets create")).toBe(false);
    expect(flag(deployOf(calls), "parallelism")).toBeUndefined();
  });

  it("gives a job the converge creates the default parallelism, as a fresh install's", async () => {
    const { run, calls } = fakeGcloud([
      [/^run jobs describe/, fail("ERROR: Cannot find job [caelo-production-audit]. NOT_FOUND")],
    ]);
    const { parallelism: _, ...converge } = TARGET;
    const r = await ensureAuditJob(converge, { run, sleep: async () => {} });
    expect(r.ok).toBe(true);
    expect(flag(deployOf(calls), "parallelism")).toBe(String(AUDIT_PARALLELISM_DEFAULT));
  });

  it("refuses to redeploy a job it cannot read on converge", async () => {
    const { run, calls } = fakeGcloud([[/^run jobs describe/, fail("PERMISSION_DENIED")]]);
    const { parallelism: _, ...converge } = TARGET;
    const r = await ensureAuditJob(converge, { run, sleep: async () => {} });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("PERMISSION_DENIED") });
    expect(deployOf(calls)).toBeUndefined();
  });

  it("on gcp-firebase reads no bucket: the task audits the public preview channel", async () => {
    const { run, calls } = fakeGcloud();
    await ensureAuditJob({ ...TARGET, provider: "gcp-firebase" }, { run, sleep: async () => {} });
    const job = grants(calls).filter((g) => g.member === AUDIT);
    expect(job.map((g) => g.role)).toEqual([
      "roles/storage.objectCreator",
      "roles/logging.logWriter",
    ]);
    expect(flag(deployOf(calls), "set-env-vars")).toBe(
      `CAELO_PROVIDER=gcp-firebase,CAELO_AUDIT_RESULTS_BUCKET=${RESULTS}`,
    );
  });

  it("refuses an image that is not pinned by digest", async () => {
    const { run, calls } = fakeGcloud();
    const r = await ensureAuditJob({ ...TARGET, adminImageRef: "x/admin:latest" }, { run });
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("refuses a parallelism outside 1-15", async () => {
    const { run } = fakeGcloud();
    const r = await ensureAuditJob({ ...TARGET, parallelism: 16 }, { run });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("1 to 15") });
  });

  it("stops at the first failed grant and names it", async () => {
    const { run, calls } = fakeGcloud([
      [
        /^storage buckets add-iam-policy-binding gs:\/\/acme-caelo-production-audit-results --member=serviceAccount:caelo-production-audit/,
        fail("PERMISSION_DENIED"),
      ],
    ]);
    const r = await ensureAuditJob(TARGET, { run, sleep: async () => {} });
    expect(r).toMatchObject({
      ok: false,
      error: expect.stringContaining("roles/storage.objectCreator"),
    });
    expect(calls.some((c) => c[2] === "deploy")).toBe(false);
  });

  it("says when the bucket name is taken by another project", async () => {
    const { run } = fakeGcloud([
      [/^storage buckets create/, fail("HTTPError 409: already exists")],
    ]);
    const r = await ensureAuditJob(TARGET, { run, sleep: async () => {} });
    expect(r).toMatchObject({
      ok: false,
      error: expect.stringContaining("does not belong to project acme"),
    });
  });
});
