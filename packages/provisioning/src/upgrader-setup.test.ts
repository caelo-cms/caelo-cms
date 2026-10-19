// SPDX-License-Identifier: MPL-2.0

/**
 * The upgrader job's setup (upgrader-setup.ts) against a fake gcloud. The
 * load-bearing assertions are the trust boundary: the upgrader's service
 * account gets exactly the app-roll rights — never IAM-policy, service
 * account admin, secret, compute or project rights — and the admin's run SA
 * can start the job (without overrides) and read its runs, nothing else.
 */

import { describe, expect, it } from "bun:test";
import type { GcloudResult } from "./gcloud.js";
import {
  ensureUpgraderJob,
  UPGRADER_FORBIDDEN_ROLES,
  UPGRADER_OPS_LIST_ROLE,
  UPGRADER_SQL_BACKUP_ROLE,
  type UpgraderSetupTarget,
} from "./upgrader-setup.js";

const ok = (stdout = ""): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });

const UPGRADER = "serviceAccount:caelo-production-upgrader@acme.iam.gserviceaccount.com";
const ADMIN_SA = "serviceAccount:caelo-production-run-sa@acme.iam.gserviceaccount.com";
const OPS = `europe-west1-docker.pkg.dev/caelo-website/caelo-cms-images/ops@sha256:${"c".repeat(64)}`;

const TARGET: UpgraderSetupTarget = {
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
    [/^iam roles describe/, fail("NOT_FOUND")],
    [/^iam service-accounts describe/, fail("NOT_FOUND")],
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

describe("ensureUpgraderJob", () => {
  it("grants the upgrader exactly the app-roll rights", async () => {
    const { run, calls } = fakeGcloud();
    const r = await ensureUpgraderJob(TARGET, { run, sleep: async () => {} });
    expect(r.ok).toBe(true);
    const mine = grants(calls).filter((g) => g.member === UPGRADER);
    expect(mine.map((g) => `${g.where} → ${g.role}`).sort()).toEqual(
      [
        "projects add-iam-policy-binding acme → projects/acme/roles/caeloUpgraderRun",
        "projects add-iam-policy-binding acme → roles/cloudsql.instanceUser",
        "projects add-iam-policy-binding acme → roles/logging.logWriter",
        "projects add-iam-policy-binding acme → projects/acme/roles/caeloUpgraderSqlBackup",
        "iam service-accounts add-iam-policy-binding caelo-production-run-sa@acme.iam.gserviceaccount.com → roles/iam.serviceAccountUser",
        "iam service-accounts add-iam-policy-binding caelo-production-gateway-sa@acme.iam.gserviceaccount.com → roles/iam.serviceAccountUser",
        "iam service-accounts add-iam-policy-binding caelo-production-upgrader@acme.iam.gserviceaccount.com → roles/iam.serviceAccountUser",
        "iam service-accounts add-iam-policy-binding caelo-mcp@acme.iam.gserviceaccount.com → roles/iam.serviceAccountTokenCreator",
        "storage buckets add-iam-policy-binding gs://acme-caelo-ops → roles/storage.objectUser",
        "storage buckets add-iam-policy-binding gs://acme-caelo-ops → projects/acme/roles/caeloUpgraderOpsList",
      ].sort(),
    );
    // The bucket grant only reaches install.json, not the Pulumi state.
    const bucket = mine.find((g) => g.role === "roles/storage.objectUser");
    expect(bucket?.condition).toContain(
      'resource.name.startsWith("projects/_/buckets/acme-caelo-ops/objects/install/")',
    );
    // gcloud storage cp lists the bucket before every upload; GCS checks the
    // list against the bucket itself, so this grant cannot carry the
    // install/ condition — and so it carries nothing but the list.
    const list = mine.find((g) => g.role.endsWith("/caeloUpgraderOpsList"));
    expect(list?.condition).toBe("None");
    expect(UPGRADER_OPS_LIST_ROLE.permissions).toEqual(["storage.objects.list"]);
  });

  it("never grants a forbidden role, a setIamPolicy permission, or a project-wide iam role", async () => {
    const { run, calls } = fakeGcloud();
    await ensureUpgraderJob(TARGET, { run, sleep: async () => {} });
    for (const g of grants(calls).filter((g) => g.member === UPGRADER)) {
      for (const forbidden of UPGRADER_FORBIDDEN_ROLES) {
        expect(g.role.startsWith(forbidden)).toBe(false);
      }
      if (g.role.startsWith("roles/iam.")) expect(g.where).toStartWith("iam service-accounts");
    }
    const role = calls.find(
      (c) =>
        c.slice(0, 3).join(" ") === "iam roles create" && c[3] === UPGRADER_SQL_BACKUP_ROLE.roleId,
    );
    const perms = (flag(role ?? [], "permissions") ?? "").split(",");
    expect(perms.sort()).toEqual([...UPGRADER_SQL_BACKUP_ROLE.permissions].sort());
    // Nothing but the one write it needs: create a backup.
    const writes = perms.filter((p) =>
      /\.(setIamPolicy|restoreBackup|update|delete|create)$/.test(p),
    );
    expect(writes).toEqual(["cloudsql.backupRuns.create"]);
  });

  it("the admin may start the job without overrides and read it — nothing else", async () => {
    const { run, calls } = fakeGcloud();
    await ensureUpgraderJob(TARGET, { run, sleep: async () => {} });
    const admin = grants(calls).filter((g) => g.member === ADMIN_SA);
    expect(admin.map((g) => `${g.where} → ${g.role}`).sort()).toEqual([
      "run jobs add-iam-policy-binding caelo-production-upgrader → roles/run.jobsExecutor",
      "run jobs add-iam-policy-binding caelo-production-upgrader → roles/run.viewer",
    ]);
    expect(calls.flat().some((a) => a.includes("WithOverrides"))).toBe(false);
  });

  it("deploys the job with no input but the database: ops image by digest, own SA, no env", async () => {
    const { run, calls } = fakeGcloud();
    await ensureUpgraderJob(TARGET, { run, sleep: async () => {} });
    const deploy = calls.find((c) => c.slice(0, 3).join(" ") === "run jobs deploy") ?? [];
    expect(deploy[3]).toBe("caelo-production-upgrader");
    expect(flag(deploy, "image")).toBe(OPS);
    expect(flag(deploy, "service-account")).toBe(UPGRADER.replace("serviceAccount:", ""));
    expect(flag(deploy, "command")).toBe("caelo-ops");
    expect(flag(deploy, "args")).toBe("upgrader");
    expect(deploy.some((a) => /env-vars|secrets/.test(a))).toBe(false);
    const assign = calls.find((c) => c.slice(0, 3).join(" ") === "sql users assign-roles");
    expect(assign?.[3]).toBe("caelo-production-upgrader@acme.iam");
    expect(flag(assign ?? [], "database-roles")).toBe("platform_updater");
  });

  it("refuses an image not pinned by digest, before touching anything", async () => {
    const { run, calls } = fakeGcloud();
    const r = await ensureUpgraderJob(
      { ...TARGET, opsImageRef: "ghcr.io/caelo-cms/ops:latest" },
      { run },
    );
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("needs the install's state in its own ops bucket", async () => {
    const { run, calls } = fakeGcloud([
      [/^storage buckets describe/, fail("404 bucket not found")],
    ]);
    const r = await ensureUpgraderJob(TARGET, { run });
    expect(r.ok ? "" : r.error).toContain("cms-provision state migrate");
    expect(grants(calls)).toEqual([]);
  });

  it("stops at the first failed grant and says which", async () => {
    const { run, calls } = fakeGcloud([
      [/add-iam-policy-binding acme .*caeloUpgraderRun/, fail("PERMISSION_DENIED")],
    ]);
    const r = await ensureUpgraderJob(TARGET, { run, sleep: async () => {} });
    expect(r.ok ? "" : r.error).toContain(
      "grant the upgrader projects/acme/roles/caeloUpgraderRun: PERMISSION_DENIED",
    );
    expect(calls.some((c) => c.slice(0, 3).join(" ") === "run jobs deploy")).toBe(false);
  });
});
