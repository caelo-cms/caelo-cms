// SPDX-License-Identifier: MPL-2.0

/**
 * The scheduler tick's setup (scheduler-setup.ts) against a fake gcloud. The
 * load-bearing assertions are the trust boundary (#1140): the scheduler's
 * account may sign as itself, pass the admin's IAP, start workflows and
 * write logs — no secret, database, storage, run or IAM-admin right — and
 * the one Cloud Scheduler job starts the workflow at the knob's cadence.
 */

import { describe, expect, it } from "bun:test";
import type { GcloudResult } from "./gcloud.js";
import {
  ensureSchedulerTick,
  SCHEDULER_FORBIDDEN_ROLES,
  SCHEDULER_TICK_PATH,
  type SchedulerTickTarget,
  schedulerWorkflowSource,
  tickOrigin,
} from "./scheduler-setup.js";

const ok = (stdout = ""): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });

const SA = "caelo-production-scheduler@acme.iam.gserviceaccount.com";
const MEMBER = `serviceAccount:${SA}`;

const TARGET: SchedulerTickTarget = {
  projectId: "acme",
  region: "europe-west1",
  env: "production",
  adminUrl: "https://admin.acme.com",
  resource: { kind: "backend-services", service: "caelo-production-admin-backend-1a2b" },
  intervalMinutes: 5,
};

function fakeGcloud(overrides: [RegExp, GcloudResult][] = []) {
  const calls: string[][] = [];
  const sources: string[] = [];
  const rules: [RegExp, GcloudResult][] = [
    ...overrides,
    [/^iam service-accounts describe/, fail("NOT_FOUND")],
    [/^scheduler jobs describe/, fail("NOT_FOUND")],
  ];
  const run = async (args: string[]) => {
    calls.push(args);
    const src = args.find((a) => a.startsWith("--source="));
    if (src) sources.push(await Bun.file(src.slice("--source=".length)).text());
    const line = args.join(" ");
    return rules.find(([re]) => re.test(line))?.[1] ?? ok("");
  };
  return { run, calls, sources };
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

const sleep = async () => {};

describe("ensureSchedulerTick", () => {
  it("grants the scheduler only self-signing, IAP access, workflow start and logs", async () => {
    const { run, calls } = fakeGcloud();
    const r = await ensureSchedulerTick(TARGET, { run, sleep });
    expect(r.ok).toBe(true);
    const mine = grants(calls).filter((g) => g.member === MEMBER);
    expect(mine.map((g) => [g.where, g.role])).toEqual([
      [`iam service-accounts add-iam-policy-binding ${SA}`, "roles/iam.serviceAccountTokenCreator"],
      ["projects add-iam-policy-binding acme", "roles/workflows.invoker"],
      ["projects add-iam-policy-binding acme", "roles/logging.logWriter"],
      [
        "iap web add-iam-policy-binding --resource-type=backend-services",
        "roles/iap.httpsResourceAccessor",
      ],
    ]);
    for (const g of mine) {
      for (const forbidden of SCHEDULER_FORBIDDEN_ROLES) {
        expect(g.role.startsWith(forbidden)).toBe(false);
      }
    }
    // Nobody else is granted anything.
    expect(grants(calls).every((g) => g.member === MEMBER)).toBe(true);
    // The IAP grant names the admin's resource.
    const iap = calls.find((c) => c[0] === "iap") as string[];
    expect(iap).toContain("--resource-type=backend-services");
    expect(iap).toContain("--service=caelo-production-admin-backend-1a2b");
  });

  it("signs as itself only: token creator on its own account, never on another", async () => {
    const { run, calls } = fakeGcloud();
    await ensureSchedulerTick(TARGET, { run, sleep });
    const saGrants = calls.filter(
      (c) => c[0] === "iam" && c[1] === "service-accounts" && c[2] === "add-iam-policy-binding",
    );
    expect(saGrants.map((c) => c[3])).toEqual([SA]);
  });

  it("deploys the workflow as the scheduler account and schedules it every 5 minutes", async () => {
    const { run, calls, sources } = fakeGcloud();
    await ensureSchedulerTick(TARGET, { run, sleep });
    const deploy = calls.find((c) => c[0] === "workflows" && c[1] === "deploy") as string[];
    expect(deploy[2]).toBe("caelo-production-scheduler-tick");
    expect(flag(deploy, "service-account")).toBe(SA);
    expect(flag(deploy, "location")).toBe("europe-west1");
    expect(sources[0]).toContain(`url: "https://admin.acme.com${SCHEDULER_TICK_PATH}"`);
    const create = calls.find(
      (c) => c[0] === "scheduler" && c[1] === "jobs" && c[2] === "create",
    ) as string[];
    expect(create[4]).toBe("caelo-production-scheduler-tick");
    expect(flag(create, "schedule")).toBe("*/5 * * * *");
    expect(flag(create, "time-zone")).toBe("Etc/UTC");
    expect(flag(create, "uri")).toBe(
      "https://workflowexecutions.googleapis.com/v1/projects/acme/locations/europe-west1/workflows/caelo-production-scheduler-tick/executions",
    );
    expect(flag(create, "oauth-service-account-email")).toBe(SA);
    // OAuth (a googleapis.com target), never an OIDC token IAP would refuse.
    expect(create.some((a) => a.startsWith("--oidc"))).toBe(false);
  });

  it("updates the existing job on a re-run, at the knob's new cadence", async () => {
    const { run, calls } = fakeGcloud([[/^scheduler jobs describe/, ok("projects/acme/…")]]);
    const r = await ensureSchedulerTick({ ...TARGET, intervalMinutes: 1 }, { run, sleep });
    expect(r.ok).toBe(true);
    const update = calls.find(
      (c) => c[0] === "scheduler" && c[1] === "jobs" && c[2] === "update",
    ) as string[];
    expect(flag(update, "schedule")).toBe("* * * * *");
    expect(calls.some((c) => c[0] === "scheduler" && c[2] === "create")).toBe(false);
  });

  it("refuses an interval outside 1-15 minutes before touching the project", async () => {
    const { run, calls } = fakeGcloud();
    const r = await ensureSchedulerTick({ ...TARGET, intervalMinutes: 30 }, { run, sleep });
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toContain("between 1 and 15");
    expect(calls).toEqual([]);
  });

  it("refuses an admin URL that is not a plain https origin", async () => {
    for (const bad of ["http://admin.acme.com", "https://admin.acme.com/x", "https://a@b.com"]) {
      const { run, calls } = fakeGcloud();
      const r = await ensureSchedulerTick({ ...TARGET, adminUrl: bad }, { run, sleep });
      expect(r.ok).toBe(false);
      expect(calls).toEqual([]);
    }
  });

  it("stops at the first failing step and says which", async () => {
    const { run, calls } = fakeGcloud([[/^workflows deploy/, fail("PERMISSION_DENIED: nope")]]);
    const r = await ensureSchedulerTick(TARGET, { run, sleep });
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toContain("deploy workflow caelo-production-scheduler-tick");
    expect(calls.some((c) => c[0] === "scheduler")).toBe(false);
  });
});

describe("schedulerWorkflowSource", () => {
  const src = schedulerWorkflowSource({ serviceAccount: SA, origin: "https://admin.acme.com" });

  it("signs a JWT for the admin origin as the scheduler itself", () => {
    expect(src).toContain(`iss: "${SA}"`);
    expect(src).toContain(`sub: "${SA}"`);
    expect(src).toContain('aud: "https://admin.acme.com/*"');
    expect(src).toContain(
      `url: "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${SA}:signJwt"`,
    );
    expect(src).toContain("type: OAuth2");
    expect(src).toContain(`exp: \${now + 600}`);
  });

  it("declares the tick as JSON, or SvelteKit refuses it as a cross-site form post", () => {
    const tick = src.slice(src.indexOf("- tick:"), src.indexOf("- done:"));
    expect(tick).toContain("Content-Type: application/json");
    expect(tick).toContain("body: {}");
  });

  it("posts the tick with the signed JWT and a bounded timeout", () => {
    expect(src).toContain('url: "https://admin.acme.com/api/internal/scheduler/tick"');
    expect(src).toContain(`Authorization: \${"Bearer " + signed.body.signedJwt}`);
    expect(src).toMatch(/timeout: (\d+)/);
    const timeout = Number(/timeout: (\d+)/.exec(src)?.[1]);
    expect(timeout).toBeGreaterThan(300);
    expect(timeout).toBeLessThanOrEqual(1800);
  });
});

describe("tickOrigin", () => {
  it("accepts the admin's origin, with or without a trailing slash", () => {
    expect(tickOrigin("https://admin.acme.com/")).toEqual({
      ok: true,
      origin: "https://admin.acme.com",
    });
    expect(tickOrigin("https://caelo-production-admin-x-ew.a.run.app")).toEqual({
      ok: true,
      origin: "https://caelo-production-admin-x-ew.a.run.app",
    });
  });
});
