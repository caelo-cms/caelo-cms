// SPDX-License-Identifier: MPL-2.0

/**
 * The converge job's setup (converge-job-setup.ts, #819) against a fake
 * gcloud. The load-bearing assertions are the trust boundary: the admin's
 * run SA may start the job without overrides and read its runs — on this
 * job only, nothing else — and the job runs the ops image by digest as the
 * install's existing provisioner, with no env and no input but the
 * database.
 */

import { describe, expect, it } from "bun:test";
import {
  CONVERGE_ADMIN_ROLES,
  type ConvergeSetupTarget,
  convergeJobDeployArgs,
  ensureConvergeJob,
} from "./converge-job-setup.js";
import type { GcloudResult } from "./gcloud.js";
import { INSTALL_JOB_ROLES } from "./install-job.js";

const ok = (stdout = ""): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });

const PROVISIONER = "caelo-provisioner@acme.iam.gserviceaccount.com";
const ADMIN_SA = "serviceAccount:caelo-production-run-sa@acme.iam.gserviceaccount.com";
const OPS = `europe-west1-docker.pkg.dev/caelo-website/caelo-cms-images/ops@sha256:${"c".repeat(64)}`;

const TARGET: ConvergeSetupTarget = {
  projectId: "acme",
  region: "europe-west1",
  env: "production",
  opsImageRef: OPS,
  network: "caelo-production-vpc",
  subnet: "caelo-production-subnet",
};

function fakeGcloud(overrides: [RegExp, GcloudResult][] = []) {
  const calls: string[][] = [];
  const rules: [RegExp, GcloudResult][] = [
    ...overrides,
    [/^iam service-accounts describe/, ok(PROVISIONER)],
    [/^sql instances list/, ok("caelo-production-pg-abc\n")],
    [/^sql instances describe/, ok('{"settings":{"databaseFlags":[]}}')],
    [/^sql users list/, ok("")],
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

function grants(calls: string[][]) {
  return calls
    .filter((c) => c.includes("add-iam-policy-binding"))
    .map((c) => ({
      where: c.slice(0, c.indexOf("add-iam-policy-binding") + 2).join(" "),
      member: flag(c, "member"),
      role: flag(c, "role") as string,
    }));
}

describe("ensureConvergeJob", () => {
  it("the admin may start the job without overrides and read it — on this job, nothing else", async () => {
    const { run, calls } = fakeGcloud();
    const r = await ensureConvergeJob(TARGET, { run, sleep: async () => {} });
    expect(r.ok).toBe(true);
    const admin = grants(calls).filter((g) => g.member === ADMIN_SA);
    expect(admin.map((g) => `${g.where} → ${g.role}`).sort()).toEqual([
      "run jobs add-iam-policy-binding caelo-production-converge → roles/run.jobsExecutor",
      "run jobs add-iam-policy-binding caelo-production-converge → roles/run.viewer",
    ]);
    expect([...CONVERGE_ADMIN_ROLES]).toEqual(["roles/run.jobsExecutor", "roles/run.viewer"]);
    // jobsExecutor has run.jobs.run but not run.jobs.runWithOverrides; no
    // role that carries it (…WithOverrides, run.developer/admin) appears.
    expect(calls.flat().some((a) => /WithOverrides|run\.developer|run\.admin/.test(a))).toBe(false);
  });

  it("runs the ops image by digest as the install's provisioner, with no env, no secrets and one fixed subcommand", async () => {
    const { run, calls } = fakeGcloud();
    await ensureConvergeJob(TARGET, { run, sleep: async () => {} });
    const deploy = calls.find((c) => c.slice(0, 3).join(" ") === "run jobs deploy") ?? [];
    expect(deploy).toEqual(convergeJobDeployArgs(TARGET));
    expect(deploy[3]).toBe("caelo-production-converge");
    expect(flag(deploy, "image")).toBe(OPS);
    expect(flag(deploy, "service-account")).toBe(PROVISIONER);
    expect(flag(deploy, "command")).toBe("caelo-ops");
    expect(flag(deploy, "args")).toBe("converge-job");
    expect(flag(deploy, "max-retries")).toBe("0");
    expect(deploy.some((a) => /env-vars|secrets|env-file/.test(a))).toBe(false);
  });

  it("gives the provisioner the install-job roles and a platform_updater database login only", async () => {
    const { run, calls } = fakeGcloud();
    await ensureConvergeJob(TARGET, { run, sleep: async () => {} });
    const mine = grants(calls).filter((g) => g.member === `serviceAccount:${PROVISIONER}`);
    expect(mine.map((g) => g.role).sort()).toEqual([...INSTALL_JOB_ROLES].sort());
    expect(mine.every((g) => g.where === "projects add-iam-policy-binding acme")).toBe(true);
    const assign = calls.find((c) => c.slice(0, 3).join(" ") === "sql users assign-roles");
    expect(assign?.[3]).toBe("caelo-provisioner@acme.iam");
    expect(flag(assign ?? [], "database-roles")).toBe("platform_updater");
  });

  it("never creates the provisioner: an install without one keeps converging from a terminal", async () => {
    const { run, calls } = fakeGcloud([[/^iam service-accounts describe/, fail("NOT_FOUND")]]);
    const r = await ensureConvergeJob(TARGET, { run });
    expect(r.ok ? "" : r.error).toContain("has no caelo-provisioner@acme.iam.gserviceaccount.com");
    expect(calls.some((c) => c.join(" ").startsWith("iam service-accounts create"))).toBe(false);
    expect(grants(calls)).toEqual([]);
  });

  it("refuses an image not pinned by digest, before touching anything", async () => {
    const { run, calls } = fakeGcloud();
    const r = await ensureConvergeJob(
      { ...TARGET, opsImageRef: "ghcr.io/caelo-cms/ops:latest" },
      { run },
    );
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("needs the install's state in its own ops bucket (the job attaches from it)", async () => {
    const { run, calls } = fakeGcloud([
      [/^storage buckets describe/, fail("404 bucket not found")],
    ]);
    const r = await ensureConvergeJob(TARGET, { run });
    expect(r.ok ? "" : r.error).toContain("cms-provision state migrate");
    expect(grants(calls)).toEqual([]);
  });

  it("stops at the first failed grant and says which", async () => {
    const { run, calls } = fakeGcloud([
      [/add-iam-policy-binding acme .*cloudscheduler/, fail("PERMISSION_DENIED")],
    ]);
    const r = await ensureConvergeJob(TARGET, { run, sleep: async () => {} });
    expect(r.ok ? "" : r.error).toContain(
      "grant the provisioner roles/cloudscheduler.admin: PERMISSION_DENIED",
    );
    expect(calls.some((c) => c.slice(0, 3).join(" ") === "run jobs deploy")).toBe(false);
  });
});
