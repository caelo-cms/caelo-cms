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
/**
 * The linux/amd64 platform manifest inside release index `D(c)`. Cloud Run
 * reports this one as a revision's `status.imageDigest` while the release
 * manifest and install.json name the index (#860 root cause).
 */
const P = (c: string) => `sha256:${"f".repeat(63)}${c}`;

const MIRROR = "europe-west1-docker.pkg.dev/caelo-website/caelo-cms-images/x";

/** `gcloud run revisions describe --format=json` of a revision deployed as `deployed` (null: by tag). */
const revisionJson = (deployed: string | null, resolved: string) =>
  JSON.stringify({
    spec: { containers: [{ image: deployed ? `${MIRROR}@${deployed}` : `${MIRROR}:0.10.45` }] },
    status: { imageDigest: `${MIRROR}@${resolved}` },
  });

/** Serving revisions deployed as `admin` / `gateway` (index digests). */
const servingAs = (admin: string, gateway: string): [RegExp, Answer] => [
  /^run revisions describe (\S+)/,
  (l) =>
    ok(
      l.includes("-admin-")
        ? revisionJson(admin, `sha256:${"e".repeat(64)}`)
        : revisionJson(gateway, `sha256:${"d".repeat(64)}`),
    ),
];

/** `gcloud artifacts docker tags list` of the mirror: `tags` maps release version → digest. */
const releaseTags = (slug: "admin" | "gateway", tags: Record<string, string>): [RegExp, Answer] => [
  new RegExp(`^artifacts docker tags list \\S+/${slug} `),
  ok(
    Object.entries(tags)
      .map(([v, d]) => `projects/p/locations/l/repositories/r/packages/${slug}/tags/${v}\t${d}`)
      .join("\n"),
  ),
];

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

const manifestOf = (version: string, admin: string, gateway: string): ReleaseManifestResult => ({
  ok: true,
  manifest: { ...MANIFEST, version, digests: { admin, gateway, ops: D("c") } },
});

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
      (l) =>
        ok(l.includes("-admin-") ? revisionJson(D("1"), P("1")) : revisionJson(D("2"), P("2"))),
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
    /** Manifests of other versions than the target (the serving release's). */
    manifests?: Record<string, ReleaseManifestResult>;
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
      const other = opts.manifests?.[v];
      if (other) return other;
      if (v !== MANIFEST.version) {
        return { ok: false, error: { code: "registry", message: `no release manifest for v${v}` } };
      }
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

  it("regression #860: Cloud Run's platform digest of the recorded index is no drift", async () => {
    // The fake reports status.imageDigest = P(…) (the platform manifest) and
    // the revision spec = D(…) (the index install.json and the manifest name).
    const { deps, order, q, written } = setup();
    expect((await runUpgraderJob(deps)).status).toBe("succeeded");
    expect(q.events.some((e) => e.message.includes("refreshed its install records"))).toBe(false);
    expect(order.filter((l) => l.startsWith("manifest"))).toEqual(["manifest 0.11.0"]);
    expect(order.some((l) => l.includes("artifacts docker tags list"))).toBe(false);
    expect(written).toHaveLength(1);
  });

  it("a revision deployed by tag matches by the digest Cloud Run resolved", async () => {
    const { deps, written } = setup({
      meta: { ...META, imageDigests: { admin: P("1"), gateway: D("2") } },
      gcloud: [
        [
          /^run revisions describe (\S+)/,
          (l) =>
            ok(l.includes("-admin-") ? revisionJson(null, P("1")) : revisionJson(D("2"), P("2"))),
        ],
      ],
    });
    expect((await runUpgraderJob(deps)).status).toBe("succeeded");
    expect(written).toHaveLength(1);
  });

  it("drift to a signed release: refreshes install.json, says so, installs judged against it", async () => {
    // Recorded: 0.10.44 (digests 9/8). Serving: 0.10.45 (digests 1/2).
    const { deps, order, q, written } = setup({
      meta: {
        ...META,
        imageDigests: { admin: D("9"), gateway: D("8") },
        releaseVersion: "0.10.44",
      },
      manifests: {
        "0.10.44": manifestOf("0.10.44", D("9"), D("8")),
        "0.10.45": manifestOf("0.10.45", D("1"), D("2")),
      },
      gcloud: [releaseTags("admin", { "0.10.44": D("9"), "0.10.45": D("1") })],
    });
    const r = await runUpgraderJob(deps);
    expect(r).toMatchObject({ exitCode: 0, status: "succeeded" });
    expect(written[0]).toMatchObject({
      releaseVersion: "0.10.45",
      imageDigests: { admin: D("1"), gateway: D("2") },
      domain: "acme.com",
      infraContractVersion: 2,
    });
    expect(q.events).toContainEqual({
      phase: "verify",
      level: "success",
      message: "Caelo refreshed its install records: v0.10.45 serves.",
    });
    // Refreshed before the target's manifest is judged, and judged against it.
    expect(step(order, /^manifest 0\.10\.45/)).toBeLessThan(step(order, /^manifest 0\.11\.0/));
    expect(q.events.some((e) => e.message.startsWith("0.10.45 → 0.11.0"))).toBe(true);
    expect(written.at(-1)).toMatchObject({ releaseVersion: "0.11.0" });
  });

  it("drift where the recorded version is the serving one needs no tag lookup", async () => {
    const { deps, order, written } = setup({
      meta: { ...META, imageDigests: { admin: D("9"), gateway: D("2") } },
      manifests: { "0.10.45": manifestOf("0.10.45", D("1"), D("2")) },
    });
    expect((await runUpgraderJob(deps)).status).toBe("succeeded");
    expect(order.some((l) => l.includes("artifacts docker tags list"))).toBe(false);
    expect(written[0]).toMatchObject({ imageDigests: { admin: D("1"), gateway: D("2") } });
  });

  it("drift to images of no signed release is refused, says so, and changes nothing", async () => {
    const { deps, order, q, written } = setup({
      gcloud: [servingAs(D("7"), D("6"))],
      manifests: { "0.10.45": manifestOf("0.10.45", D("1"), D("2")) },
    });
    const r = await runUpgraderJob(deps);
    expect(r.status).toBe("needs_cloud_shell");
    const end = q.end();
    expect(end?.codes).toEqual(["install-state-drift"]);
    expect(end?.reason).toContain("do not belong to one signed Caelo release");
    expect(end?.reason).toContain(`admin ${D("7")}`);
    expect(written).toEqual([]);
    expect(order.some((l) => /backups create|services update|^migrate/.test(l))).toBe(false);
    expect(order).not.toContain("manifest 0.11.0");
  });

  it("regression #865: drift whose release manifest the registry cannot serve fails retryably, not install-state-drift", async () => {
    const { deps, order, q, written } = setup({
      meta: {
        ...META,
        imageDigests: { admin: D("9"), gateway: D("8") },
        releaseVersion: "0.10.44",
      },
      manifests: {
        "0.10.44": manifestOf("0.10.44", D("9"), D("8")),
        "0.10.45": {
          ok: false,
          error: { code: "registry", message: "503 Service Unavailable", transient: true },
        },
      },
      gcloud: [releaseTags("admin", { "0.10.44": D("9"), "0.10.45": D("1") })],
    });
    const r = await runUpgraderJob(deps);
    expect(r.status).toBe("failed");
    const end = q.end();
    expect(end?.codes).toEqual(["registry"]);
    expect(end?.reason).toContain("503 Service Unavailable");
    expect(end?.reason).toContain("Try again later");
    expect(end?.reason).not.toContain("Cloud Shell");
    expect(written).toEqual([]);
    expect(order).not.toContain("manifest 0.11.0");
  });

  it("regression #865: drift whose candidate manifest does not exist (404) ends in install-state-drift, not a retry", async () => {
    const { deps, q, written } = setup({
      meta: {
        ...META,
        imageDigests: { admin: D("9"), gateway: D("8") },
        releaseVersion: "0.10.44",
      },
      manifests: {
        "0.10.44": manifestOf("0.10.44", D("9"), D("8")),
        "0.10.45": {
          ok: false,
          error: { code: "registry", message: "no release manifest for v0.10.45 (HTTP 404)" },
        },
      },
      gcloud: [releaseTags("admin", { "0.10.44": D("9"), "0.10.45": D("1") })],
    });
    expect((await runUpgraderJob(deps)).status).toBe("needs_cloud_shell");
    const end = q.end();
    expect(end?.codes).toEqual(["install-state-drift"]);
    expect(end?.reason).toContain("HTTP 404");
    expect(end?.reason).not.toContain("Try again later");
    expect(written).toEqual([]);
  });

  it("drift with a signature-rejected candidate still ends in install-state-drift", async () => {
    const { deps, q, written } = setup({
      meta: {
        ...META,
        imageDigests: { admin: D("9"), gateway: D("8") },
        releaseVersion: "0.10.44",
      },
      manifests: {
        "0.10.44": manifestOf("0.10.44", D("9"), D("8")),
        "0.10.45": { ok: false, error: { code: "signature", message: "not signed" } },
      },
      gcloud: [releaseTags("admin", { "0.10.44": D("9"), "0.10.45": D("1") })],
    });
    expect((await runUpgraderJob(deps)).status).toBe("needs_cloud_shell");
    expect(q.end()?.codes).toEqual(["install-state-drift"]);
    expect(written).toEqual([]);
  });

  it("partial match (the admin of a release, the gateway not) is refused", async () => {
    const { deps, q, written } = setup({
      gcloud: [servingAs(D("1"), D("6"))],
      meta: { ...META, imageDigests: { admin: D("9"), gateway: D("8") } },
      manifests: { "0.10.45": manifestOf("0.10.45", D("1"), D("2")) },
    });
    expect((await runUpgraderJob(deps)).status).toBe("needs_cloud_shell");
    expect(q.end()?.reason).toContain("The admin serves v0.10.45's image, the gateway does not");
    expect(written).toEqual([]);
  });

  it("admin and gateway of two different signed releases are refused, naming both", async () => {
    // Each image is genuinely signed, but no ONE release names both: a mixed
    // deployment no release vouches for.
    const { deps, q, written } = setup({
      gcloud: [
        servingAs(D("9"), D("2")),
        releaseTags("admin", { "0.10.44": D("9") }),
        releaseTags("gateway", { "0.10.45": D("2") }),
      ],
      meta: {
        ...META,
        imageDigests: { admin: D("1"), gateway: D("2") },
        releaseVersion: "0.10.45",
      },
      manifests: {
        "0.10.44": manifestOf("0.10.44", D("9"), D("8")),
        "0.10.45": manifestOf("0.10.45", D("1"), D("2")),
      },
    });
    expect((await runUpgraderJob(deps)).status).toBe("needs_cloud_shell");
    const end = q.end();
    expect(end?.codes).toEqual(["install-state-drift"]);
    expect(end?.reason).toContain("The gateway serves v0.10.45's image, the admin does not");
    expect(end?.reason).toContain("the admin serves v0.10.44's image, the gateway does not");
    expect(written).toEqual([]);
  });

  it("an older signed release serving is recorded as what it is, and the target judged from it", async () => {
    // install.json says 0.10.45, but someone put 0.10.44 back: the heal must
    // record the OLDER version, never keep claiming the newer one.
    const { deps, q, written } = setup({
      gcloud: [servingAs(D("9"), D("8")), releaseTags("admin", { "0.10.44": D("9") })],
      manifests: {
        "0.10.44": manifestOf("0.10.44", D("9"), D("8")),
        "0.10.45": manifestOf("0.10.45", D("1"), D("2")),
      },
    });
    expect((await runUpgraderJob(deps)).status).toBe("succeeded");
    expect(written[0]).toMatchObject({
      releaseVersion: "0.10.44",
      imageDigests: { admin: D("9"), gateway: D("8") },
    });
    expect(q.events.some((e) => e.message.startsWith("0.10.44 → 0.11.0"))).toBe(true);
  });

  it("a release whose manifest does not verify is never recorded", async () => {
    const { deps, q, written } = setup({
      meta: { ...META, imageDigests: { admin: D("9"), gateway: D("8") } },
      manifests: {
        "0.10.45": { ok: false, error: { code: "signature", message: "cert identity mismatch" } },
      },
    });
    expect((await runUpgraderJob(deps)).status).toBe("needs_cloud_shell");
    expect(q.end()?.reason).toContain("could not be verified: v0.10.45 (cert identity mismatch)");
    expect(written).toEqual([]);
  });

  it("an install.json without digests is refreshed the same way", async () => {
    const { imageDigests: _none, ...bare } = META;
    const { deps, written } = setup({
      meta: bare,
      manifests: { "0.10.45": manifestOf("0.10.45", D("1"), D("2")) },
    });
    expect((await runUpgraderJob(deps)).status).toBe("succeeded");
    expect(written[0]).toMatchObject({ imageDigests: { admin: D("1"), gateway: D("2") } });
  });

  it("a refresh that cannot be written stops before anything changes", async () => {
    const { deps, order, q } = setup({
      meta: { ...META, imageDigests: { admin: D("9"), gateway: D("2") } },
      manifests: { "0.10.45": manifestOf("0.10.45", D("1"), D("2")) },
    });
    const r = await runUpgraderJob({
      ...deps,
      writeInstall: () => {
        throw new Error("403 on the ops bucket");
      },
    });
    expect(r).toMatchObject({ exitCode: 1, status: "failed" });
    expect(q.end()?.codes).toEqual(["install-state-write"]);
    expect(q.end()?.reason).toContain("403 on the ops bucket");
    expect(order.some((l) => /backups create|services update|^migrate/.test(l))).toBe(false);
  });

  it("a failed install.json write after the roll fails the run instead of ending succeeded", async () => {
    const { deps, order, q } = setup();
    const r = await runUpgraderJob({
      ...deps,
      writeInstall: () => {
        throw new Error("403 on the ops bucket");
      },
    });
    expect(r).toMatchObject({ exitCode: 1, status: "failed" });
    expect(q.end()?.codes).toEqual(["record"]);
    expect(q.end()?.reason).toContain("0.11.0 serves");
    expect(q.events.some((e) => e.phase === "record" && e.level === "error")).toBe(true);
    // The new release keeps serving: no rollback, no self-update.
    expect(order.some((l) => /--to-revisions/.test(l))).toBe(false);
    expect(order.some((l) => /jobs update caelo-production-upgrader/.test(l))).toBe(false);
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
