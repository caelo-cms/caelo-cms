// SPDX-License-Identifier: MPL-2.0

/**
 * The capture job's setup (capture-job-setup.ts) against a fake gcloud. The
 * load-bearing assertions are the trust boundary (#1217): the job's service
 * account may create results under `out/` of the capture bucket and write
 * logs — no read right anywhere, no secret, database, IAM, IAP or run
 * rights, no VPC — and the admin may only run the job with overrides, read
 * its executions, use the capture bucket and sign URLs as itself.
 */

import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  CAPTURE_FORBIDDEN_ROLES,
  CAPTURE_TASK_SCRIPT,
  type CaptureJobTarget,
  ensureCaptureJob,
} from "./capture-job-setup.js";
import type { GcloudResult } from "./gcloud.js";

const ok = (stdout = ""): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });

const CAPTURE = "serviceAccount:caelo-production-capture@acme.iam.gserviceaccount.com";
const ADMIN_SA_EMAIL = "caelo-production-run-sa@acme.iam.gserviceaccount.com";
const ADMIN_SA = `serviceAccount:${ADMIN_SA_EMAIL}`;
const ADMIN_IMAGE = `europe-west1-docker.pkg.dev/caelo-website/caelo-cms-images/admin@sha256:${"a".repeat(64)}`;
const BUCKET = "acme-caelo-production-capture";

const TARGET: CaptureJobTarget = {
  provider: "gcp",
  projectId: "acme",
  region: "europe-west1",
  env: "production",
  adminImageRef: ADMIN_IMAGE,
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

/** Every IAM grant the setup made, as {where, member, role, condition}. */
function grants(calls: string[][]) {
  return calls
    .filter((c) => c.includes("add-iam-policy-binding"))
    .map((c) => ({
      where: c.slice(0, c.indexOf("add-iam-policy-binding") + 2).join(" "),
      member: flag(c, "member"),
      role: flag(c, "role") as string,
      condition: flag(c, "condition"),
    }));
}

const deployOf = (calls: string[][]) =>
  calls.find((c) => c[0] === "run" && c[1] === "jobs" && c[2] === "deploy") as string[];

describe("ensureCaptureJob", () => {
  it("grants the job only result-create under out/ and logs — no read right anywhere", async () => {
    const { run, calls } = fakeGcloud();
    const r = await ensureCaptureJob(TARGET, { run, sleep: async () => {} });
    expect(r.ok).toBe(true);
    const job = grants(calls).filter((g) => g.member === CAPTURE);
    expect(job.map((g) => [g.where, g.role])).toEqual([
      [`storage buckets add-iam-policy-binding gs://${BUCKET}`, "roles/storage.objectCreator"],
      ["projects add-iam-policy-binding acme", "roles/logging.logWriter"],
    ]);
    for (const g of job) {
      for (const forbidden of CAPTURE_FORBIDDEN_ROLES) {
        expect(g.role.startsWith(forbidden)).toBe(false);
      }
    }
    // Create only under out/: it cannot plant an input the admin hands on.
    expect(job[0]?.condition).toContain(
      `resource.name.startsWith("projects/_/buckets/${BUCKET}/objects/out/")`,
    );
    // Nothing on the media, staging or static buckets, nothing on IAP.
    expect(
      calls.some((c) => c.join(" ").includes("iap") && c.includes(`--member=${CAPTURE}`)),
    ).toBe(false);
  });

  it("gives the admin run-with-overrides + view on the job, the bucket, and signing as itself only", async () => {
    const { run, calls } = fakeGcloud();
    await ensureCaptureJob(TARGET, { run, sleep: async () => {} });
    expect(
      grants(calls)
        .filter((g) => g.member === ADMIN_SA)
        .map((g) => [g.where, g.role]),
    ).toEqual([
      [`storage buckets add-iam-policy-binding gs://${BUCKET}`, "roles/storage.objectUser"],
      [
        `iam service-accounts add-iam-policy-binding ${ADMIN_SA_EMAIL}`,
        "roles/iam.serviceAccountTokenCreator",
      ],
      [
        "run jobs add-iam-policy-binding caelo-production-capture",
        "roles/run.jobsExecutorWithOverrides",
      ],
      ["run jobs add-iam-policy-binding caelo-production-capture", "roles/run.viewer"],
    ]);
    // TokenCreator is on the admin's own account, never on the project or
    // another account.
    const signer = grants(calls).find((g) => g.role === "roles/iam.serviceAccountTokenCreator");
    expect(signer?.where).toBe(`iam service-accounts add-iam-policy-binding ${ADMIN_SA_EMAIL}`);
    expect(signer?.member).toBe(ADMIN_SA);
  });

  it("no principal but the admin gets a grant on the job or the bucket", async () => {
    const { run, calls } = fakeGcloud();
    await ensureCaptureJob(TARGET, { run, sleep: async () => {} });
    for (const g of grants(calls)) expect([CAPTURE, ADMIN_SA]).toContain(g.member as string);
  });

  it("points the job at a task script the admin image ships", () => {
    const repoRoot = join(import.meta.dir, "..", "..", "..");
    expect(CAPTURE_TASK_SCRIPT.startsWith("/app/packages/")).toBe(true);
    expect(existsSync(join(repoRoot, CAPTURE_TASK_SCRIPT.slice("/app/".length)))).toBe(true);
  });

  it("deploys the admin image as its own SA with no secrets and no VPC", async () => {
    const { run, calls } = fakeGcloud();
    await ensureCaptureJob(TARGET, { run, sleep: async () => {} });
    const deploy = deployOf(calls);
    expect(flag(deploy, "image")).toBe(ADMIN_IMAGE);
    expect(flag(deploy, "service-account")).toBe(
      "caelo-production-capture@acme.iam.gserviceaccount.com",
    );
    expect(flag(deploy, "args")).toBe(`--bun,${CAPTURE_TASK_SCRIPT}`);
    expect(flag(deploy, "max-retries")).toBe("0");
    expect(flag(deploy, "set-env-vars")).toBe(`CAELO_PROVIDER=gcp,CAELO_CAPTURE_BUCKET=${BUCKET}`);
    const line = deploy.join(" ");
    for (const banned of ["--network", "--subnet", "--vpc", "--set-secrets", "--update-secrets"]) {
      expect(line).not.toContain(banned);
    }
  });

  it("creates the private bucket with a one-day lifecycle when it is missing, keeps an existing one", async () => {
    const fresh = fakeGcloud();
    await ensureCaptureJob(TARGET, { run: fresh.run, sleep: async () => {} });
    const create = fresh.calls.find(
      (c) => c.slice(0, 3).join(" ") === "storage buckets create",
    ) as string[];
    expect(create).toContain(`gs://${BUCKET}`);
    expect(create).toContain("--public-access-prevention");
    expect(create).toContain("--uniform-bucket-level-access");
    expect(fresh.calls.some((c) => c.join(" ").includes("--lifecycle-file="))).toBe(true);

    const existing = fakeGcloud([[/^storage buckets list/, ok(`gs://${BUCKET}/\n`)]]);
    expect((await ensureCaptureJob(TARGET, { run: existing.run, sleep: async () => {} })).ok).toBe(
      true,
    );
    expect(existing.calls.some((c) => c.slice(0, 3).join(" ") === "storage buckets create")).toBe(
      false,
    );
  });

  it("deploys the same shape on gcp-firebase", async () => {
    const { run, calls } = fakeGcloud();
    await ensureCaptureJob({ ...TARGET, provider: "gcp-firebase" }, { run, sleep: async () => {} });
    expect(flag(deployOf(calls), "set-env-vars")).toBe(
      `CAELO_PROVIDER=gcp-firebase,CAELO_CAPTURE_BUCKET=${BUCKET}`,
    );
  });

  it("refuses an image that is not pinned by digest", async () => {
    const { run, calls } = fakeGcloud();
    const r = await ensureCaptureJob({ ...TARGET, adminImageRef: "x/admin:latest" }, { run });
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("stops at the first failed grant and names it, before deploying", async () => {
    const { run, calls } = fakeGcloud([
      [
        /^storage buckets add-iam-policy-binding gs:\/\/acme-caelo-production-capture --member=serviceAccount:caelo-production-capture/,
        fail("PERMISSION_DENIED"),
      ],
    ]);
    const r = await ensureCaptureJob(TARGET, { run, sleep: async () => {} });
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
    const r = await ensureCaptureJob(TARGET, { run, sleep: async () => {} });
    expect(r).toMatchObject({
      ok: false,
      error: expect.stringContaining("does not belong to project acme"),
    });
  });
});
