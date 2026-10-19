// SPDX-License-Identifier: MPL-2.0

/**
 * The upgrader job (upgrader-job.ts) against fakes: an in-memory request
 * queue, a fake gcloud for a healthy gcp-firebase install, a fake signed
 * manifest and health probe. Checks the order (backup before migrations,
 * self-update last), what lands on the timeline, and how each failure ends
 * the request.
 */

import { describe, expect, it } from "bun:test";
import type { StoredUpdatePolicy } from "@caelo-cms/shared";
import type { GcloudResult } from "./gcloud.js";
import type { GcloudRunner } from "./gcloud-retry.js";
import type { InstallMetadata } from "./install-state.js";
import type { ReleaseManifest, ReleaseManifestResult } from "./release-manifest.js";
import { StateLockHeldError } from "./state-store.js";
import type { HealthOutcome, HealthProbe } from "./upgrade/health.js";
import {
  type ClaimedUpdate,
  runUpgraderJob,
  type UpdateEnd,
  type UpdateFacts,
  type UpdateQueue,
  type UpgraderJobDeps,
} from "./upgrader-job.js";

const ok = (stdout = ""): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });
const D = (c: string) => `sha256:${c.repeat(64)}`;

const ADMIN = "caelo-production-admin-aaa";
const GATEWAY = "caelo-production-gateway-bbb";

const MANIFEST: ReleaseManifest = {
  manifestVersion: 1,
  version: "0.11.0",
  channel: "stable",
  digests: { admin: D("a"), gateway: D("b"), ops: D("c") },
  minFromVersion: "0.10.0",
  infraContractVersion: 2,
  migrations: { contract: false, lastContractVersion: null, head: "0267_platform_updates" },
  security: true,
  advisories: ["GHSA-abcd-efgh-ijkm"],
};

const POLICY: StoredUpdatePolicy = {
  mode: "notify",
  autoSecurity: false,
  autoPatch: false,
  autoMinor: false,
  autoConverge: false,
  channel: "stable",
  windowStart: null,
  windowEnd: null,
  windowTimezone: "UTC",
  soakHours: 24,
  securitySoakHours: 2,
  paused: false,
  pausedReason: null,
  pausedAt: null,
  pausedUntil: null,
  pausedByOwner: false,
  updatedAt: "2026-10-13T00:00:00Z",
};

const META: InstallMetadata = {
  installId: "gcp-firebase-acme",
  provider: "gcp-firebase",
  projectId: "acme",
  domain: "acme.com",
  ownerEmail: "owner@acme.com",
  region: "europe-west1",
  createdAt: "2026-01-01T00:00:00Z",
  imageDigests: { admin: D("1"), gateway: D("2") },
  releaseVersion: "0.10.45",
  infraContractVersion: 2,
};

const serviceJson = (image: string, env: unknown[]) =>
  JSON.stringify({ spec: { template: { spec: { containers: [{ image, env }] } } } });
const secretRef = (name: string, secret: string) => ({
  name,
  valueFrom: { secretKeyRef: { name: `caelo-production-${secret}`, key: "latest" } },
});
const ADMIN_JSON = serviceJson("registry/admin@sha256:old", [
  { name: "CAELO_FIREBASE_SITE", value: "caelo-production-site-abc123" },
  {
    name: "ADMIN_DATABASE_URL",
    value: "postgresql://admin_role@10.20.0.3:5432/cms_admin?sslmode=require",
  },
  secretRef("ADMIN_DATABASE_PASSWORD", "postgres-password"),
]);
const GATEWAY_JSON = serviceJson("registry/gateway@sha256:old", []);

type Answer = GcloudResult | ((line: string) => GcloudResult);

function fakeGcloud(events: string[], overrides: [RegExp, Answer][] = []) {
  const rules: [RegExp, Answer][] = [
    ...overrides,
    [/^run services list .*caelo-production-admin/, ok(`${ADMIN}\n`)],
    [/^run services list .*caelo-production-gateway/, ok(`${GATEWAY}\n`)],
    [/describe (\S+) .*revisionName/, (l) => ok(`${l.split(" ")[3]}-00001-old\n`)],
    [new RegExp(`describe ${ADMIN} .*--format=json`), ok(ADMIN_JSON)],
    [new RegExp(`describe ${GATEWAY} .*--format=json`), ok(GATEWAY_JSON)],
    [/describe (\S+) .*status\.url/, (l) => ok(`https://${l.split(" ")[3]}-xyz.a.run.app\n`)],
    [
      /^run revisions describe (\S+)/,
      (l) => ok(`registry/x@${l.includes("-admin-") ? D("1") : D("2")}\n`),
    ],
    [/^sql instances list/, ok("caelo-production-pg-abc\n")],
    [/^sql backups list/, ok("1760000000000\n")],
  ];
  const run: GcloudRunner = async (args) => {
    const line = args.join(" ");
    events.push(`gcloud ${line}`);
    const rule = rules.find(([re]) => re.test(line));
    if (!rule) return ok("{}");
    return typeof rule[1] === "function" ? rule[1](line) : rule[1];
  };
  return run;
}

/** An in-memory queue holding one pending request. */
function memoryQueue(request: ClaimedUpdate | null) {
  const events: { phase: string; level: string; message: string }[] = [];
  const facts: UpdateFacts[] = [];
  let end: UpdateEnd | null = null;
  const queue: UpdateQueue = {
    claim: async () => request,
    event: async (_id, phase, level, message) => {
      events.push({ phase, level, message });
    },
    record: async (_id, f) => {
      facts.push(f);
    },
    finish: async (_id, e) => {
      end = e;
      return true;
    },
  };
  return { queue, events, facts, end: () => end };
}

function healthProbe(order: string[], deep: HealthOutcome): HealthProbe {
  return {
    baseline: async () => {
      order.push("health baseline");
      return { ok: true, detail: "reachable" };
    },
    deep: async () => {
      order.push("health deep");
      return deep;
    },
  };
}

function setup(
  opts: {
    request?: Partial<ClaimedUpdate>;
    manifest?: ReleaseManifestResult;
    meta?: InstallMetadata | null;
    gcloud?: [RegExp, Answer][];
    deep?: HealthOutcome;
    migrate?: { ok: boolean; error?: string };
    locked?: boolean;
    lockDenied?: boolean;
  } = {},
) {
  const order: string[] = [];
  const request: ClaimedUpdate = {
    id: "req-1",
    targetVersion: "0.11.0",
    trigger: "manual",
    policy: POLICY,
    ...opts.request,
  };
  const q = memoryQueue(request);
  const written: InstallMetadata[] = [];
  const deps: UpgraderJobDeps = {
    queue: q.queue,
    run: fakeGcloud(order, opts.gcloud),
    sleep: async () => {},
    projectId: "acme",
    region: "europe-west1",
    env: "production",
    execution: "caelo-production-upgrader-x1",
    fetchManifest: async (v) => {
      order.push(`manifest ${v}`);
      return opts.manifest ?? { ok: true, manifest: MANIFEST };
    },
    lockState: () => {
      order.push("lock");
      if (opts.locked) throw new StateLockHeldError("held by caelo installer");
      if (opts.lockDenied) throw new Error("storage.objects.list denied");
      return () => order.push("unlock");
    },
    readInstall: () => (opts.meta === undefined ? META : opts.meta),
    writeInstall: (m) => {
      written.push(m);
    },
    migrate: async (imageRef) => {
      order.push(`migrate ${imageRef}`);
      return opts.migrate ?? { ok: true };
    },
    healthProbe: async () => ({
      ok: true,
      probe: healthProbe(order, opts.deep ?? { ok: true, detail: "fine" }),
    }),
    now: () => new Date("2026-10-13T12:00:00Z"),
    log: () => {},
  };
  return { deps, order, q, written };
}

const step = (order: string[], re: RegExp) => order.findIndex((l) => re.test(l));

describe("runUpgraderJob", () => {
  it("does nothing without a pending request", async () => {
    const { deps } = setup();
    const r = await runUpgraderJob({ ...deps, queue: memoryQueue(null).queue });
    expect(r).toEqual({ exitCode: 0, requestId: null, status: null });
  });

  it("happy path: verify, backup, migrate, roll, health, record, self-update — in that order", async () => {
    const { deps, order, q, written } = setup();
    const r = await runUpgraderJob(deps);
    expect(r).toEqual({ exitCode: 0, requestId: "req-1", status: "succeeded" });
    const manifest = step(order, /^manifest 0\.11\.0/);
    const backup = step(order, /^gcloud sql backups create/);
    const migrate = step(order, /^migrate .*admin@sha256:a{64}/);
    const roll = step(order, /^gcloud run services update caelo-production-admin-aaa/);
    const deep = step(order, /^health deep/);
    const self = step(
      order,
      /^gcloud run jobs update caelo-production-upgrader .*ops@sha256:c{64}/,
    );
    expect([manifest, backup, migrate, roll, deep, self].every((i) => i >= 0)).toBe(true);
    expect(
      manifest < backup && backup < migrate && migrate < roll && roll < deep && deep < self,
    ).toBe(true);
    // Images come from the signed manifest, pinned by digest, from the fixed mirror.
    expect(
      order.some((l) =>
        l.includes(`europe-west1-docker.pkg.dev/caelo-website/caelo-cms-images/admin@${D("a")}`),
      ),
    ).toBe(true);
    expect(written.at(-1)).toMatchObject({
      releaseVersion: "0.11.0",
      imageDigests: { admin: D("a"), gateway: D("b") },
    });
    expect(q.facts).toContainEqual(
      expect.objectContaining({ manifestSecurity: true, opsDigest: D("c") }),
    );
    expect(q.facts).toContainEqual({ backupId: "1760000000000" });
    expect(q.end()).toEqual({
      status: "succeeded",
      reason: null,
      codes: [],
      pauseAutoUpdates: false,
    });
    const phases = [...new Set(q.events.map((e) => e.phase))];
    expect(phases).toEqual([
      "start",
      "verify",
      "assess",
      "backup",
      "health-baseline",
      "migrations",
      "roll",
      "health",
      "record",
      "self-update",
      "finish",
    ]);
  });

  it("holds the install's state lock for the whole run, and stops when another run holds it", async () => {
    const ok = setup();
    await runUpgraderJob(ok.deps);
    expect(ok.order[0]).toBe("lock");
    expect(ok.order.indexOf("unlock")).toBeGreaterThan(
      step(ok.order, /jobs update caelo-production-upgrader/),
    );

    const busy = setup({ locked: true });
    const r = await runUpgraderJob(busy.deps);
    expect(r.status).toBe("failed");
    expect(busy.q.end()?.codes).toEqual(["state-locked"]);
    expect(busy.order.some((l) => l.startsWith("manifest") || l.startsWith("gcloud"))).toBe(false);
  });

  it("does not call a lock it cannot take 'busy': an access failure asks for Cloud Shell", async () => {
    const denied = setup({ lockDenied: true });
    const r = await runUpgraderJob(denied.deps);
    expect(r.status).toBe("needs_cloud_shell");
    const end = denied.q.end();
    expect(end?.codes).toEqual(["state-access"]);
    expect(end?.reason).not.toContain("another install operation");
    expect(end?.reason).toContain("storage.objects.list denied");
    expect(denied.order.some((l) => l.startsWith("manifest") || l.startsWith("gcloud"))).toBe(
      false,
    );
  });

  it("retries recording the end, and fails the run when it cannot", async () => {
    const { deps, q } = setup();
    let calls = 0;
    const flaky: UpdateQueue = {
      ...q.queue,
      finish: async (id, end) => {
        calls += 1;
        if (calls < 3) throw new Error("connection reset");
        return q.queue.finish(id, end);
      },
    };
    expect(await runUpgraderJob({ ...deps, queue: flaky })).toMatchObject({
      exitCode: 0,
      status: "succeeded",
    });
    expect(calls).toBe(3);

    const dead: UpdateQueue = {
      ...q.queue,
      finish: async () => {
        throw new Error("database gone");
      },
    };
    expect((await runUpgraderJob({ ...deps, queue: dead })).exitCode).toBe(1);
  });

  it("an infrastructure change goes to Cloud Shell before anything changes", async () => {
    const { deps, order, q } = setup({ meta: { ...META, infraContractVersion: 1 } });
    const r = await runUpgraderJob(deps);
    expect(r.status).toBe("needs_cloud_shell");
    expect(q.end()?.codes).toEqual(["infra-contract"]);
    expect(order.some((l) => /backups create|services update|^migrate/.test(l))).toBe(false);
    expect(q.facts[0]).toMatchObject({ infraContractRequired: 2, infraContractInstalled: 1 });
  });

  it("a bad signature is refused and changes nothing", async () => {
    const { deps, order, q } = setup({
      manifest: { ok: false, error: { code: "signature", message: "cert identity mismatch" } },
    });
    expect((await runUpgraderJob(deps)).status).toBe("refused");
    expect(q.end()?.codes).toEqual(["signature"]);
    // Only read-only lookups ran.
    expect(order.filter((l) => l.startsWith("gcloud") && !/ (list|describe) /.test(l))).toEqual([]);
  });

  it("install state outside the install's own cloud needs Cloud Shell", async () => {
    const { deps, q } = setup({ meta: null });
    expect((await runUpgraderJob(deps)).status).toBe("needs_cloud_shell");
    expect(q.end()?.codes).toEqual(["install-state"]);
  });

  it("refuses when the serving release is not the recorded one (a lost install.json write)", async () => {
    const { deps, order, q } = setup({
      meta: { ...META, imageDigests: { admin: D("9"), gateway: D("2") } },
    });
    expect((await runUpgraderJob(deps)).status).toBe("needs_cloud_shell");
    expect(q.end()?.codes).toEqual(["install-state-drift"]);
    expect(order.some((l) => l.startsWith("manifest"))).toBe(false);
  });

  it("a failed install.json write still ends succeeded, and the next run catches the drift", async () => {
    const { deps, q } = setup();
    const r = await runUpgraderJob({
      ...deps,
      writeInstall: () => {
        throw new Error("403 on the ops bucket");
      },
    });
    expect(r.status).toBe("succeeded");
    expect(q.events.some((e) => e.phase === "record" && e.level === "warn")).toBe(true);
  });

  it("a failed backup stops before migrations", async () => {
    const { deps, order, q } = setup({ gcloud: [[/^sql backups create/, fail("quota")]] });
    const r = await runUpgraderJob(deps);
    expect(r).toMatchObject({ exitCode: 1, status: "failed" });
    expect(q.end()?.codes).toEqual(["backup"]);
    expect(order.some((l) => l.startsWith("migrate"))).toBe(false);
  });

  it("failed migrations: failed, previous release keeps serving, backup named", async () => {
    const { deps, order, q } = setup({ migrate: { ok: false, error: "boom" } });
    const r = await runUpgraderJob(deps);
    expect(r.status).toBe("failed");
    expect(q.end()?.reason).toContain("1760000000000");
    expect(order.some((l) => /services update caelo-production-admin/.test(l))).toBe(false);
  });

  it("an unhealthy release is rolled back; an automatic one pauses auto updates", async () => {
    const { deps, order, q } = setup({
      deep: { ok: false, error: "version mismatch" },
      request: { trigger: "auto", policy: { ...POLICY, mode: "auto", autoSecurity: true } },
    });
    const r = await runUpgraderJob(deps);
    expect(r).toMatchObject({ exitCode: 1, status: "rolled_back" });
    expect(q.end()).toMatchObject({ status: "rolled_back", pauseAutoUpdates: true });
    expect(
      order.some((l) => /update-traffic caelo-production-admin-aaa .*--to-revisions/.test(l)),
    ).toBe(true);
    expect(order.some((l) => /jobs update caelo-production-upgrader/.test(l))).toBe(false);
    expect(q.events.some((e) => e.phase === "rollback")).toBe(true);
  });

  it("a failed self-update only warns", async () => {
    const { deps, q } = setup({
      gcloud: [[/^run jobs update caelo-production-upgrader/, fail("denied")]],
    });
    expect((await runUpgraderJob(deps)).status).toBe("succeeded");
    expect(q.events.some((e) => e.phase === "self-update" && e.level === "warn")).toBe(true);
  });

  it("an unexpected throw ends the request as failed", async () => {
    const { deps, q } = setup();
    const r = await runUpgraderJob({
      ...deps,
      fetchManifest: async () => {
        throw new Error("kaboom");
      },
    });
    expect(r.status).toBe("failed");
    expect(q.end()?.reason).toContain("kaboom");
  });
});
