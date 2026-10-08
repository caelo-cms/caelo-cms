// SPDX-License-Identifier: MPL-2.0

/**
 * The operator-access sync job's setup (operator-access.ts) against a fake
 * gcloud. The load-bearing assertions are the trust boundary: only the job's
 * own service account gets IAM-policy rights, and only on the admin's IAP
 * resource and the caelo-mcp account; the admin's run SA ends up able to
 * start the job and read its runs — nothing else — and loses what an earlier
 * revision gave it.
 */

import { describe, expect, it } from "bun:test";
import type { GcloudResult } from "./gcloud.js";
import {
  ensureOperatorAccessSync,
  installIapAllowlist,
  OPERATOR_ACCESS_ROLE,
  type OperatorAccessSyncTarget,
  resolveOperatorAccessTarget,
  withIamAuthFlag,
} from "./operator-access.js";

const ok = (stdout = ""): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });

function fakeGcloud(answers: Record<string, GcloudResult[]>) {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    const key = Object.keys(answers)
      .sort((a, b) => b.length - a.length)
      .find((k) => args.join(" ").startsWith(k));
    return (key && answers[key]?.shift()) || ok();
  };
  return { run, calls, lines: () => calls.map((c) => c.join(" ")) };
}

const JOB_SA = "caelo-production-opaccess@p.iam.gserviceaccount.com";
const RUN_SA = "caelo-production-run-sa@p.iam.gserviceaccount.com";
const CUSTOM = "projects/p/roles/caeloOperatorAccess";

const target: OperatorAccessSyncTarget = {
  projectId: "p",
  region: "europe-west1",
  env: "production",
  ownerEmail: "Owner@x.com",
  resource: { kind: "cloud-run", service: "caelo-production-admin-abc", region: "europe-west1" },
  imageRef: "europe-west1-docker.pkg.dev/r/admin@sha256:new",
  network: "net",
  subnet: "sub",
  databaseHost: "10.0.0.3",
};

const roleJson = JSON.stringify({ includedPermissions: [...OPERATOR_ACCESS_ROLE.permissions] });
const legacyIapPolicy = JSON.stringify({
  bindings: [{ role: CUSTOM, members: [`serviceAccount:${RUN_SA}`] }],
});
const flagsJson = JSON.stringify({
  settings: { databaseFlags: [{ name: "max_connections", value: "50" }] },
});

const freshInstall = () =>
  fakeGcloud({
    "iam roles describe": [ok(roleJson)],
    "iap web get-iam-policy": [ok(legacyIapPolicy)],
    "iam service-accounts get-iam-policy": [ok("{}")],
    "projects get-iam-policy": [ok("{}")],
    "sql instances list": [ok("caelo-production-pg-1a2b\n")],
    "sql instances describe": [ok(flagsJson)],
    "sql users list": [ok("admin_role\npublic_role\n")],
    "scheduler jobs describe": [fail("NOT_FOUND")],
  });

/** Every IAM-binding add as {resource words, member, role}. */
function grants(calls: string[][]) {
  return calls
    .filter((c) => c.includes("add-iam-policy-binding"))
    .map((c) => ({
      on: c.slice(0, c.indexOf("add-iam-policy-binding") + 2).join(" "),
      member: c.find((a) => a.startsWith("--member="))?.slice(9),
      role: c.find((a) => a.startsWith("--role="))?.slice(7),
    }));
}

describe("ensureOperatorAccessSync", () => {
  it("gives IAM-policy rights to the job's own SA only, on exactly the IAP resource and caelo-mcp", async () => {
    const { run, calls } = freshInstall();
    const r = await ensureOperatorAccessSync(target, { run, sleep: async () => {} });
    expect(r.ok).toBe(true);
    const custom = grants(calls).filter((g) => g.role === CUSTOM);
    expect(custom).toEqual([
      {
        on: "iap web add-iam-policy-binding --resource-type=cloud-run",
        member: `serviceAccount:${JOB_SA}`,
        role: CUSTOM,
      },
      {
        on: "iam service-accounts add-iam-policy-binding caelo-mcp@p.iam.gserviceaccount.com",
        member: `serviceAccount:${JOB_SA}`,
        role: CUSTOM,
      },
    ]);
    // Nothing that can write IAM policy goes to the project or to anyone else.
    expect(
      grants(calls)
        .filter((g) => g.on.startsWith("projects"))
        .map((g) => g.role),
    ).toEqual(["roles/cloudsql.instanceUser", "roles/logging.logWriter"]);
  });

  it("leaves the admin's run SA able to start the job and read its runs — nothing else", async () => {
    const { run, calls } = freshInstall();
    await ensureOperatorAccessSync(target, { run, sleep: async () => {} });
    expect(grants(calls).filter((g) => g.member === `serviceAccount:${RUN_SA}`)).toEqual([
      {
        on: "run jobs add-iam-policy-binding caelo-production-operator-access-sync",
        member: `serviceAccount:${RUN_SA}`,
        role: "roles/run.jobsExecutor",
      },
      {
        on: "run jobs add-iam-policy-binding caelo-production-operator-access-sync",
        member: `serviceAccount:${RUN_SA}`,
        role: "roles/run.viewer",
      },
    ]);
    // jobsExecutor carries run.jobs.run but not run.jobs.runWithOverrides.
    expect(calls.flat().some((a) => /WithOverrides|run\.developer|run\.admin/.test(a))).toBe(false);
  });

  it("removes the operator-access grant an earlier revision gave the admin's run SA", async () => {
    const { run, lines } = freshInstall();
    await ensureOperatorAccessSync(target, { run, sleep: async () => {} });
    const removals = lines().filter((l) => l.includes("remove-iam-policy-binding"));
    expect(removals).toHaveLength(1);
    expect(removals[0]).toContain("iap web remove-iam-policy-binding");
    expect(removals[0]).toContain(`--member=serviceAccount:${RUN_SA}`);
    expect(removals[0]).toContain(`--role=${CUSTOM}`);
  });

  it("turns on IAM database auth without dropping existing flags, and makes the job a read-only DB user", async () => {
    const { run, lines } = freshInstall();
    await ensureOperatorAccessSync(target, { run, sleep: async () => {} });
    expect(lines()).toContain(
      "sql instances patch caelo-production-pg-1a2b --project=p --database-flags=max_connections=50,cloudsql.iam_authentication=on --quiet",
    );
    expect(lines()).toContain(
      "sql users create caelo-production-opaccess@p.iam --instance=caelo-production-pg-1a2b --type=cloud_iam_service_account --project=p --quiet",
    );
    expect(lines()).toContain(
      "sql users assign-roles caelo-production-opaccess@p.iam --instance=caelo-production-pg-1a2b --type=cloud_iam_service_account --database-roles=operator_access_reader --project=p --quiet",
    );
  });

  it("deploys the job from the admin image as its own SA, with its whole input as env", async () => {
    const { run, calls } = freshInstall();
    await ensureOperatorAccessSync(target, { run, sleep: async () => {} });
    const deploy = calls.find((c) => c.slice(0, 3).join(" ") === "run jobs deploy");
    expect(deploy).toContain(`--service-account=${JOB_SA}`);
    expect(deploy).toContain(`--image=${target.imageRef}`);
    expect(deploy).toContain(
      "--args=--bun,/app/packages/admin-core/src/security/operator-access/sync-job.ts",
    );
    expect(deploy).toContain(
      "--set-env-vars=^|^CAELO_OPERATOR_ACCESS_IAP_WEB=cloud_run-europe-west1/services/caelo-production-admin-abc|CAELO_MCP_IAP_SERVICE_ACCOUNT=caelo-mcp@p.iam.gserviceaccount.com|CAELO_OPERATOR_ACCESS_STATIC_MEMBERS=user:owner@x.com|CAELO_OPERATOR_ACCESS_DB_HOST=10.0.0.3",
    );
  });

  it("schedules an hourly run as the job's own SA", async () => {
    const { run, lines } = freshInstall();
    await ensureOperatorAccessSync(target, { run, sleep: async () => {} });
    const create = lines().find((l) => l.startsWith("scheduler jobs create http"));
    expect(create).toContain("--schedule=17 * * * *");
    expect(create).toContain(
      "--uri=https://run.googleapis.com/v2/projects/p/locations/europe-west1/jobs/caelo-production-operator-access-sync:run",
    );
    expect(create).toContain(`--oauth-service-account-email=${JOB_SA}`);
  });

  it("is idempotent on a converged install: no flag patch, no user create, scheduler updated", async () => {
    const { run, lines } = fakeGcloud({
      "iam roles describe": [ok(roleJson)],
      "sql instances list": [ok("caelo-production-pg-1a2b\n")],
      "sql instances describe": [
        ok(
          JSON.stringify({
            settings: {
              databaseFlags: [
                { name: "max_connections", value: "50" },
                { name: "cloudsql.iam_authentication", value: "on" },
              ],
            },
          }),
        ),
      ],
      "sql users list": [ok("caelo-production-opaccess@p.iam\n")],
      "scheduler jobs describe": [ok("projects/p/locations/europe-west1/jobs/x")],
    });
    const r = await ensureOperatorAccessSync(target, { run, sleep: async () => {} });
    expect(r.ok).toBe(true);
    expect(lines().some((l) => l.startsWith("sql instances patch"))).toBe(false);
    expect(lines().some((l) => l.startsWith("sql users create"))).toBe(false);
    expect(lines().some((l) => l.includes("remove-iam-policy-binding"))).toBe(false);
    expect(lines().some((l) => l.startsWith("scheduler jobs update http"))).toBe(true);
  });

  it("fails loudly naming the step, and reports what was already done", async () => {
    const { run } = fakeGcloud({
      "iam roles describe": [ok(roleJson)],
      "sql instances list": [ok("caelo-production-pg-1a2b\n")],
      "sql instances describe": [ok(flagsJson)],
      "run jobs deploy": [fail("PERMISSION_DENIED: run.jobs.create")],
    });
    const r = await ensureOperatorAccessSync(target, { run, sleep: async () => {} });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe(
        "deploy job caelo-production-operator-access-sync: PERMISSION_DENIED: run.jobs.create",
      );
      expect(r.done).toContain("custom role caeloOperatorAccess");
    }
  });

  it("refuses to guess the Cloud SQL instance", async () => {
    const { run } = fakeGcloud({
      "iam roles describe": [ok(roleJson)],
      "sql instances list": [ok("caelo-production-pg-a\ncaelo-production-pg-b\n")],
    });
    const r = await ensureOperatorAccessSync(target, { run, sleep: async () => {} });
    expect(r.ok === false && r.error).toContain("exactly one caelo-production-pg*");
  });
});

describe("withIamAuthFlag", () => {
  it("keeps every existing flag and adds the IAM auth flag once", () => {
    expect(withIamAuthFlag([{ name: "max_connections", value: "50" }])).toEqual([
      { name: "max_connections", value: "50" },
      { name: "cloudsql.iam_authentication", value: "on" },
    ]);
    expect(withIamAuthFlag([{ name: "cloudsql.iam_authentication", value: "on" }])).toBeNull();
    expect(withIamAuthFlag([{ name: "cloudsql.iam_authentication", value: "off" }])).toEqual([
      { name: "cloudsql.iam_authentication", value: "on" },
    ]);
  });
});

describe("installIapAllowlist", () => {
  it("is the owner, as the wizard passes it to the stack and the job keeps it", () => {
    expect(installIapAllowlist(" Owner@X.com ")).toEqual(["user:owner@x.com"]);
  });
});

describe("resolveOperatorAccessTarget", () => {
  const adminJson = JSON.stringify({
    spec: {
      template: {
        metadata: {
          annotations: {
            "run.googleapis.com/network-interfaces": JSON.stringify([
              {
                network: "projects/p/global/networks/net",
                subnetwork: "projects/p/regions/r/subnetworks/sub",
              },
            ]),
          },
        },
        spec: {
          containers: [
            {
              image: "img@sha256:live",
              env: [
                {
                  name: "ADMIN_DATABASE_URL",
                  value: "postgresql://admin_role@10.0.0.3:5432/cms_admin",
                },
              ],
            },
          ],
        },
      },
    },
  });
  const base = { projectId: "p", region: "europe-west1", env: "production", ownerEmail: "o@x.com" };

  it("gcp: targets the single IAP-enabled admin backend service", async () => {
    const { run } = fakeGcloud({
      "run services list": [ok("caelo-production-admin-abc\n")],
      "run services describe": [ok(adminJson)],
      "compute backend-services list": [ok("caelo-production-admin-backend-1a2b\n")],
    });
    const r = await resolveOperatorAccessTarget(
      { ...base, provider: "gcp", imageRef: "img@sha256:new" },
      { run },
    );
    expect(r).toEqual({
      ok: true,
      target: {
        ...base,
        resource: { kind: "backend-services", service: "caelo-production-admin-backend-1a2b" },
        imageRef: "img@sha256:new",
        network: "net",
        subnet: "sub",
        databaseHost: "10.0.0.3",
      },
    });
  });

  it("gcp-firebase: the admin service itself is the IAP resource; refuses an ambiguous service", async () => {
    const one = fakeGcloud({
      "run services list": [ok("caelo-production-admin-abc\n")],
      "run services describe": [ok(adminJson)],
    });
    const r = await resolveOperatorAccessTarget(
      { ...base, provider: "gcp-firebase" },
      { run: one.run },
    );
    expect(r.ok && r.target.resource).toEqual({
      kind: "cloud-run",
      service: "caelo-production-admin-abc",
      region: "europe-west1",
    });
    expect(r.ok && r.target.imageRef).toBe("img@sha256:live");

    const two = fakeGcloud({
      "run services list": [ok("caelo-production-admin-a\ncaelo-production-admin-b\n")],
    });
    const r2 = await resolveOperatorAccessTarget(
      { ...base, provider: "gcp-firebase" },
      { run: two.run },
    );
    expect(r2.ok === false && r2.error).toContain("exactly one");
  });
});
