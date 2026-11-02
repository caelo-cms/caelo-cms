// SPDX-License-Identifier: MPL-2.0

/**
 * The upgrade split (epic #696) against a fake gcloud: the converge half and
 * the app-roll half each stay on their side, the backup is the first change
 * and stops everything when it fails, and a failed deep health check rolls
 * traffic back and prints the restore command.
 */

import { describe, expect, it } from "bun:test";
import type { GcloudResult } from "../gcloud.js";
import type { GcloudRunner } from "../gcloud-retry.js";
import { MCP_ARMOR_RULE } from "../remote-mcp-edge.js";
import type { HttpFetch } from "../runtime-secrets.js";
import {
  type AppRollInstall,
  type AppRollPlan,
  executeAppRoll,
  planAppRoll,
  type ReleaseImage,
  type RollSlug,
} from "./app-roll.js";
import { restoreCommand, takeSqlBackup } from "./backup.js";
import { needsConverge, startConverge } from "./converge.js";
import { createIapHealthProbe, type HealthOutcome, type HealthProbe } from "./health.js";
import type { UpgradeReporter } from "./reporter.js";
import {
  type GcpUpgradeDeps,
  type GcpUpgradeTarget,
  upgradeGcpInstall,
  upgradeGcpInstallOutcome,
} from "./upgrade.js";

const ok = (stdout = ""): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });

const ADMIN = "caelo-production-admin-aaa";
/** gcp-firebase: the visitor gateway, under its fixed name since #1328. */
const GATEWAY = "caelo-production-data-gateway";
/** gcp-firebase: the service that was the gateway and is the MCP-Auth-Proxy (E13 a). */
const PROXY = "caelo-production-gateway-bbb";
/** gcp: the proxy's fixed name (the gateway keeps its auto-named service). */
const GCP_PROXY = "caelo-production-mcp-auth-proxy";
const SQL = "caelo-production-pg-abc";
const BACKUP_ID = "1760000000000";
const DIGEST = {
  admin: `sha256:${"a".repeat(64)}`,
  gateway: `sha256:${"b".repeat(64)}`,
  "mcp-auth-proxy": `sha256:${"d".repeat(64)}`,
};
const IMAGES: Record<RollSlug, ReleaseImage> = {
  admin: { digest: DIGEST.admin, imageRef: `registry/admin@${DIGEST.admin}` },
  gateway: { digest: DIGEST.gateway, imageRef: `registry/gateway@${DIGEST.gateway}` },
  "mcp-auth-proxy": {
    digest: DIGEST["mcp-auth-proxy"],
    imageRef: `registry/mcp-auth-proxy@${DIGEST["mcp-auth-proxy"]}`,
  },
};

const secretRef = (name: string, secret: string) => ({
  name,
  valueFrom: { secretKeyRef: { name: `caelo-production-${secret}`, key: "latest" } },
});

/**
 * A described service, as `gcloud run services describe --format=json`
 * returns it. `ingress`: the service-level setting (#732). Always-on CPU,
 * as every install the stacks created before `cpuIdle` was set runs.
 */
const serviceJson = (image: string, env: unknown[], ingress = "all", vpc = true) =>
  JSON.stringify({
    metadata: { annotations: { "run.googleapis.com/ingress": ingress } },
    spec: {
      template: {
        metadata: {
          annotations: {
            "run.googleapis.com/cpu-throttling": "false",
            ...(vpc
              ? {
                  "run.googleapis.com/network-interfaces": JSON.stringify([
                    { network: "caelo-production-vpc", subnetwork: "caelo-production-subnet" },
                  ]),
                }
              : {}),
          },
        },
        spec: { containers: [{ image, env }] },
      },
    },
  });

/** The admin image the install runs before the upgrade (digest-pinned, as deployed). */
const OLD_ADMIN_IMAGE = `registry/admin@sha256:${"0".repeat(64)}`;
const ADMIN_JSON = serviceJson(OLD_ADMIN_IMAGE, [
  { name: "CAELO_FIREBASE_SITE", value: "caelo-production-site-abc123" },
  {
    name: "ADMIN_DATABASE_URL",
    value:
      "postgresql://admin_role@db1.p-label.europe-west1.sql-psa.goog:5432/cms_admin?sslmode=verify-full&sslrootcert=/etc/caelo/db-ca/cloudsql-global.pem",
  },
  {
    name: "PUBLIC_ADMIN_DATABASE_URL",
    value:
      "postgresql://admin_role@db1.p-label.europe-west1.sql-psa.goog:5432/cms_public?sslmode=verify-full&sslrootcert=/etc/caelo/db-ca/cloudsql-global.pem",
  },
  secretRef("ADMIN_DATABASE_PASSWORD", "postgres-password"),
  secretRef("PUBLIC_ADMIN_DATABASE_PASSWORD", "postgres-password"),
]);
const GATEWAY_JSON = serviceJson("registry/gateway@sha256:old", [
  {
    name: "PUBLIC_DATABASE_URL",
    value:
      "postgresql://public_role@db1.p-label.europe-west1.sql-psa.goog:5432/cms_public?sslmode=verify-full&sslrootcert=/etc/caelo/db-ca/cloudsql-global.pem",
  },
  secretRef("PUBLIC_DATABASE_PASSWORD", "public-role-password"),
]);

/**
 * gcp-firebase: the service that was the gateway, before this upgrade turns
 * it into the MCP-Auth-Proxy — the visitor gateway's database login, the
 * staging gate key and the remote-MCP broker's env, on the VPC.
 */
const PROXY_JSON = serviceJson("registry/gateway@sha256:old", [
  {
    name: "PUBLIC_DATABASE_URL",
    value:
      "postgresql://public_role@db1.p-label.europe-west1.sql-psa.goog:5432/cms_public?sslmode=verify-full&sslrootcert=/etc/caelo/db-ca/cloudsql-global.pem",
  },
  secretRef("PUBLIC_DATABASE_PASSWORD", "public-role-password"),
  secretRef("CAELO_STAGING_GATE_SECRET", "staging-gate-secret"),
  secretRef("CAELO_MCP_OAUTH_SEAL_KEY", "mcp-oauth-seal-key"),
  { name: "CAELO_OPERATOR_OAUTH_CLIENT_FILE", value: "/secrets/operator-oauth-client/client.json" },
]);
/** gcp: the MCP-Auth-Proxy the converge deployed (no VPC, no database). */
const GCP_PROXY_JSON = serviceJson("registry/mcp-auth-proxy@sha256:old", [], "all", false);

type Answer = GcloudResult | ((line: string) => GcloudResult);

/**
 * A fake gcloud for a healthy gcp-firebase install: the first matching rule
 * answers; anything else succeeds with `{}` (an empty IAM policy, an empty
 * listing). Every call lands in `events` too, so tests can check the order
 * against the non-gcloud steps.
 */
function fakeInstall(events: string[], overrides: [RegExp, Answer][] = []) {
  const rules: [RegExp, Answer][] = [
    ...overrides,
    [/^run services list .*caelo-production-admin/, ok(`${ADMIN}\n`)],
    [/^run services list .*caelo-production-data-gateway/, ok(`${GATEWAY}\n`)],
    // On gcp this prefix is the gateway's, on gcp-firebase the proxy's.
    [/^run services list .*caelo-production-gateway/, ok(`${PROXY}\n`)],
    [/^run services list .*caelo-production-mcp-auth-proxy/, ok(`${GCP_PROXY}\n`)],
    [/describe (\S+) .*revisionName/, (l) => ok(`${l.split(" ")[3]}-00001-old\n`)],
    [new RegExp(`describe ${ADMIN} .*--format=json`), ok(ADMIN_JSON)],
    [new RegExp(`describe ${GATEWAY} .*--format=json`), ok(GATEWAY_JSON)],
    [new RegExp(`describe ${PROXY} .*--format=json`), ok(PROXY_JSON)],
    [new RegExp(`describe ${GCP_PROXY} .*--format=json`), ok(GCP_PROXY_JSON)],
    [/describe (\S+) .*status\.url/, (l) => ok(`https://${l.split(" ")[3]}-xyz.a.run.app\n`)],
    [
      /^run jobs describe caelo-production-(audit|capture) .*containers\[0\]\.image/,
      ok(`${OLD_ADMIN_IMAGE}\n`),
    ],
    [/^sql instances list/, ok(`${SQL}\n`)],
    [/^sql backups list/, ok(`${BACKUP_ID}\n`)],
    [
      /^secrets describe caelo-production-postgres-password .*json/,
      ok('{"replication":{"automatic":{}}}'),
    ],
    [/^secrets versions list/, ok("projects/acme/secrets/x/versions/1\n")],
    [/^secrets versions access/, ok("stored-password")],
    [/^secrets describe/, ok("name\n")],
    [/^projects describe/, ok("42\n")],
    [/^auth print-access-token/, ok("ya29.token\n")],
  ];
  const calls: string[] = [];
  const run: GcloudRunner = async (args) => {
    const line = args.join(" ");
    calls.push(line);
    events.push(`gcloud ${line}`);
    const rule = rules.find(([re]) => re.test(line));
    if (!rule) return ok("{}");
    const answer = rule[1];
    return typeof answer === "function" ? answer(line) : answer;
  };
  return { run, calls };
}

/** Cloud SQL Admin API: every operation is done at once. */
const http: HttpFetch = async () => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ name: "op-1", status: "DONE" }),
});

function recordingReporter() {
  const lines: string[] = [];
  const reporter: UpgradeReporter = {
    step: (label) => {
      lines.push(`step: ${label}`);
      return {
        done: (m) => lines.push(`done: ${m}`),
        failed: (m) => lines.push(`failed: ${m}`),
        warned: (m) => lines.push(`warned: ${m}`),
        progress: (m) => lines.push(`progress: ${m}`),
      };
    },
    info: (m) => lines.push(`info: ${m}`),
    warn: (m) => lines.push(`warn: ${m}`),
    error: (m) => lines.push(`error: ${m}`),
    success: (m) => lines.push(`success: ${m}`),
  };
  return { reporter, lines };
}

function fakeHealth(events: string[], deep: HealthOutcome = { ok: true, detail: "fine" }) {
  const probe: HealthProbe = {
    baseline: async () => {
      events.push("health baseline");
      return { ok: true, detail: "reachable" };
    },
    deep: async (expect) => {
      events.push(`health deep ${expect.version ?? "-"}`);
      return deep;
    },
  };
  return probe;
}

const noSleep = async () => {};

const TARGET: GcpUpgradeTarget = {
  provider: "gcp-firebase",
  projectId: "acme",
  region: "europe-west1",
  env: "production",
  domain: "acme.com",
  stagingHost: "staging.acme.com",
  ownerEmail: "owner@acme.com",
  targetTag: "0.11.0",
  infraContractVersion: 1,
  skipVerify: false,
  skipHealthCheck: false,
  credentials: "operator",
};

/** The same install on the `gcp` provider (load balancer + URL map). */
const GCP_TARGET: GcpUpgradeTarget = { ...TARGET, provider: "gcp" };

function upgradeDeps(
  events: string[],
  opts: { overrides?: [RegExp, Answer][]; deep?: HealthOutcome } = {},
) {
  const gcloud = fakeInstall(events, opts.overrides);
  const { reporter, lines } = recordingReporter();
  const recorded: { digests: unknown[]; contract: number[] } = { digests: [], contract: [] };
  const deps: GcpUpgradeDeps = {
    run: gcloud.run,
    reporter,
    sleep: noSleep,
    http,
    resolveImages: async () => ({ ok: true, images: IMAGES }),
    verifyImages: async () => {
      events.push("verify images");
      return true;
    },
    migrate: async (imageRef) => {
      events.push(`migrate ${imageRef}`);
      return { ok: true };
    },
    healthProbe: async () => ({ ok: true, probe: fakeHealth(events, opts.deep) }),
    resolveOpsImage: async () => `registry/ops@sha256:${"c".repeat(64)}`,
    recordDigests: async (d) => {
      events.push("record digests");
      recorded.digests.push(d);
    },
    recordInfraContractVersion: (v) => {
      events.push("record contract");
      recorded.contract.push(v);
    },
    now: () => new Date("2026-10-13T10:00:00Z"),
  };
  return { deps, calls: gcloud.calls, lines, recorded };
}

/** Calls that change IAM, service accounts, secrets or APIs — converge-only. */
const CONVERGE_WRITE =
  /add-iam-policy-binding|remove-iam-policy-binding|set-iam-policy|service-accounts create|secrets create|secrets versions add|services enable|roles create|roles update|roles undelete|firewall-rules delete|users assign-roles/;
/** Calls that move a service or run migrations — app-roll-only. */
const APP_ROLL_WRITE =
  /^run services update |^run services update-traffic|jobs execute caelo-migrate|^run jobs update caelo-production-(audit|capture) /;
/** Any gcloud call that changes something. */
const ANY_WRITE =
  /\b(create|update|update-traffic|delete|add-iam-policy-binding|remove-iam-policy-binding|set-iam-policy|execute|enable|add|restore)\b/;

/**
 * #1328 — the only writes allowed before the backup: the MCP-Auth-Proxy's
 * account, its secretAccessor on its two secrets, and the services an older
 * install lacks (mcp-auth-proxy-setup.ts). Additive; nothing serves on them.
 */
const PRE_PLAN_WRITE =
  /^(iam service-accounts create caelo-production-mcp-proxy-sa |secrets add-iam-policy-binding caelo-production-(mcp-oauth-seal-key|operator-oauth-client) .*--member=serviceAccount:caelo-production-mcp-proxy-sa@|run services replace |run deploy caelo-production-mcp-auth-proxy )/;

const indexOf = (events: string[], pattern: RegExp): number => {
  const i = events.findIndex((e) => pattern.test(e));
  if (i < 0) throw new Error(`no event matches ${pattern}:\n${events.join("\n")}`);
  return i;
};

describe("upgradeGcpInstall — converge, then app-roll", () => {
  it("takes the backup first, migrates before rolling, checks health, records the digests", async () => {
    const events: string[] = [];
    const { deps, recorded, lines } = upgradeDeps(events);
    expect(await upgradeGcpInstall(TARGET, deps)).toBe(true);

    const backup = indexOf(events, /^gcloud sql backups create/);
    const firstConvergeWrite =
      backup + indexOf(events.slice(backup), /^gcloud .*(add-iam-policy-binding|secrets create)/);
    const baseline = indexOf(events, /^health baseline/);
    const migrate = indexOf(events, /^migrate registry\/admin@/);
    const adminRoll = indexOf(events, new RegExp(`^gcloud run services update ${ADMIN} `));
    const gatewayRoll = indexOf(events, new RegExp(`^gcloud run services update ${GATEWAY} `));
    const proxyRoll = indexOf(events, new RegExp(`^gcloud run services update ${PROXY} `));
    const deep = indexOf(events, /^health deep 0\.11\.0/);
    const digests = indexOf(events, /^record digests/);

    // Before the backup only the additive pre-plan step writes (#1328): the
    // MCP-Auth-Proxy's account and its two secret grants.
    for (const e of events.slice(0, backup)) expect(e).not.toMatch(/^(migrate|record)/);
    for (const e of events.slice(0, backup).filter((e) => e.startsWith("gcloud "))) {
      const call = e.slice("gcloud ".length);
      if (ANY_WRITE.test(call)) expect(call).toMatch(PRE_PLAN_WRITE);
    }
    expect(backup).toBeLessThan(firstConvergeWrite);
    expect(firstConvergeWrite).toBeLessThan(baseline);
    expect(baseline).toBeLessThan(migrate);
    expect(migrate).toBeLessThan(adminRoll);
    expect(adminRoll).toBeLessThan(gatewayRoll);
    // The proxy rolls last: on gcp-firebase it forwards to the new gateway.
    expect(gatewayRoll).toBeLessThan(proxyRoll);
    expect(proxyRoll).toBeLessThan(deep);
    expect(deep).toBeLessThan(digests);
    expect(recorded.digests).toEqual([DIGEST]);
    expect(lines).toContain(`done: Pre-upgrade backup ${BACKUP_ID} of ${SQL} taken`);
  });

  it("sets up the upgrader job after migrations, before operator access keeps its caelo-mcp grant (#696)", async () => {
    const events: string[] = [];
    const { deps, lines } = upgradeDeps(events);
    expect(await upgradeGcpInstall(TARGET, deps)).toBe(true);
    expect(lines).toContain(
      "done: Upgrader job ready (the Owner can install updates from the admin)",
    );
    const migrate = indexOf(events, /^migrate /);
    const upgrader = indexOf(events, /^gcloud run jobs deploy caelo-production-upgrader /);
    const opAccess = indexOf(
      events,
      /^gcloud run jobs deploy caelo-production-operator-access-sync /,
    );
    expect(migrate < upgrader && upgrader < opAccess).toBe(true);
    expect(events[upgrader]).toContain(`--image=registry/ops@sha256:${"c".repeat(64)}`);
    expect(events[opAccess]).toContain(
      "CAELO_OPERATOR_ACCESS_MCP_SIGNERS=serviceAccount:caelo-production-upgrader@acme.iam.gserviceaccount.com",
    );
  });

  it("sets up the quality-audit job on the CURRENT admin image before the roll, then moves it with the admin (#875)", async () => {
    const events: string[] = [];
    const { deps, lines } = upgradeDeps(events);
    expect(await upgradeGcpInstall(TARGET, deps)).toBe(true);
    const deploy = indexOf(events, /^gcloud run jobs deploy caelo-production-audit /);
    const adminRoll = indexOf(events, new RegExp(`^gcloud run services update ${ADMIN} `));
    const move = indexOf(events, /^gcloud run jobs update caelo-production-audit /);
    const deep = indexOf(events, /^health deep/);
    expect(events[deploy]).toContain(`--image=${OLD_ADMIN_IMAGE}`);
    expect(deploy < adminRoll && adminRoll < move && move < deep).toBe(true);
    expect(events[move]).toContain(`--image=${IMAGES.admin.imageRef}`);
    expect(lines).toContain("done: Quality-audit job ready (Stage audits run in parallel)");
  });

  it("a failed audit-job setup leaves the converge incomplete and the admin's audit env untouched", async () => {
    const events: string[] = [];
    const { deps, recorded, lines } = upgradeDeps(events, {
      overrides: [[/^run jobs deploy caelo-production-audit/, fail("PERMISSION_DENIED")]],
    });
    expect(await upgradeGcpInstall(TARGET, deps)).toBe(true);
    expect(recorded.contract).toEqual([]);
    expect(lines.some((l) => l.includes("Quality-audit job not set up"))).toBe(true);
    expect(
      events.some((e) => /services update caelo-production-admin.*CAELO_AUDIT_JOB=/.test(e)),
    ).toBe(false);
  });

  it("sets up the capture job on the CURRENT admin image before the roll, then moves it with the admin (#1217)", async () => {
    const events: string[] = [];
    const { deps, lines } = upgradeDeps(events);
    expect(await upgradeGcpInstall(TARGET, deps)).toBe(true);
    const deploy = indexOf(events, /^gcloud run jobs deploy caelo-production-capture /);
    const adminRoll = indexOf(events, new RegExp(`^gcloud run services update ${ADMIN} `));
    const move = indexOf(events, /^gcloud run jobs update caelo-production-capture /);
    const deep = indexOf(events, /^health deep/);
    expect(events[deploy]).toContain(`--image=${OLD_ADMIN_IMAGE}`);
    expect(deploy < adminRoll && adminRoll < move && move < deep).toBe(true);
    expect(events[move]).toContain(`--image=${IMAGES.admin.imageRef}`);
    expect(events[adminRoll]).toContain(
      "CAELO_CAPTURE_JOB=projects/acme/locations/europe-west1/jobs/caelo-production-capture",
    );
    expect(lines).toContain("done: Capture job ready (screenshots run outside the admin)");
  });

  it("a failed capture-job setup leaves the converge incomplete and the admin's capture env untouched", async () => {
    const events: string[] = [];
    const { deps, recorded, lines } = upgradeDeps(events, {
      overrides: [[/^run jobs deploy caelo-production-capture/, fail("PERMISSION_DENIED")]],
    });
    expect(await upgradeGcpInstall(TARGET, deps)).toBe(true);
    expect(recorded.contract).toEqual([]);
    expect(lines.some((l) => l.includes("Capture job not set up"))).toBe(true);
    expect(
      events.some((e) => /services update caelo-production-admin.*CAELO_CAPTURE_JOB=/.test(e)),
    ).toBe(false);
    expect(
      events.some((e) => /services update caelo-production-admin.*CAELO_CAPTURE_BUCKET=/.test(e)),
    ).toBe(false);
  });

  it("an unreadable audit job is reported as an error, not as a missing job, and is not moved", async () => {
    const events: string[] = [];
    const { deps, lines } = upgradeDeps(events, {
      overrides: [
        [
          /^run jobs describe caelo-production-audit .*containers\[0\]\.image/,
          fail("PERMISSION_DENIED"),
        ],
      ],
    });
    expect(await upgradeGcpInstall(TARGET, deps)).toBe(true);
    expect(
      lines.some((l) => l.includes("Could not read the quality-audit job (PERMISSION_DENIED)")),
    ).toBe(true);
    expect(lines.some((l) => l.includes("has no quality-audit job yet"))).toBe(false);
    expect(events.some((e) => /^gcloud run jobs update caelo-production-audit /.test(e))).toBe(
      false,
    );
  });

  it("a missing audit job is reported as missing", async () => {
    const events: string[] = [];
    const { deps, lines } = upgradeDeps(events, {
      overrides: [
        [
          /^run jobs describe caelo-production-audit .*containers\[0\]\.image/,
          fail(
            "ERROR: (gcloud.run.jobs.describe) Cannot find job [caelo-production-audit]. NOT_FOUND",
          ),
        ],
      ],
    });
    expect(await upgradeGcpInstall(TARGET, deps)).toBe(true);
    expect(lines.some((l) => l.includes("has no quality-audit job yet"))).toBe(true);
  });

  it("without an ops image the upgrader step fails, the roll goes on, the converge is incomplete", async () => {
    const events: string[] = [];
    const { deps, recorded, lines } = upgradeDeps(events);
    expect(await upgradeGcpInstall(TARGET, { ...deps, resolveOpsImage: async () => null })).toBe(
      true,
    );
    expect(events.some((e) => /jobs deploy caelo-production-upgrader/.test(e))).toBe(false);
    expect(recorded.contract).toEqual([]);
    expect(lines.some((l) => l.includes("Upgrader job not set up"))).toBe(true);
    // The admin keeps whatever CAELO_UPGRADER_JOB it had.
    expect(
      events.some((e) => /services update caelo-production-admin.*CAELO_UPGRADER_JOB=/.test(e)),
    ).toBe(false);
  });

  it("verifies the ops image's signature before the upgrader runs it; unverified = not set up", async () => {
    const events: string[] = [];
    const { deps } = upgradeDeps(events);
    const verified: string[] = [];
    expect(
      await upgradeGcpInstall(TARGET, {
        ...deps,
        verifyImages: async (images) => {
          verified.push(...images.map((i) => i.slug));
          return !images.some((i) => i.slug === "ops");
        },
      }),
    ).toBe(true);
    expect(verified).toContain("ops");
    expect(events.some((e) => /jobs deploy caelo-production-upgrader/.test(e))).toBe(false);
  });

  it("a failed upgrader setup keeps an existing upgrader's caelo-mcp signing grant", async () => {
    const events: string[] = [];
    const { deps } = upgradeDeps(events, {
      overrides: [
        [/^run jobs deploy caelo-production-upgrader/, fail("transient")],
        [/^iam service-accounts describe caelo-production-upgrader@/, ok("x\n")],
      ],
    });
    expect(await upgradeGcpInstall(TARGET, deps)).toBe(true);
    const opAccess = indexOf(
      events,
      /^gcloud run jobs deploy caelo-production-operator-access-sync /,
    );
    expect(events[opAccess]).toContain(
      "CAELO_OPERATOR_ACCESS_MCP_SIGNERS=serviceAccount:caelo-production-upgrader@",
    );
  });

  it("a failed backup stops the upgrade before any change", async () => {
    const events: string[] = [];
    const { deps, calls, lines, recorded } = upgradeDeps(events, {
      overrides: [
        [
          /^sql backups create/,
          fail("ERROR: (gcloud.sql.backups.insert) HTTPError 409: operation in progress"),
        ],
      ],
    });
    expect(await upgradeGcpInstall(TARGET, deps)).toBe(false);

    // Only the additive pre-plan grants (#1328) came before it.
    const writes = calls.filter((c) => ANY_WRITE.test(c) && !PRE_PLAN_WRITE.test(c));
    expect(writes).toEqual([
      expect.stringMatching(/^sql backups create --instance caelo-production-pg-abc/),
    ]);
    expect(events.some((e) => /^(migrate|health|record)/.test(e))).toBe(false);
    expect(recorded.digests).toEqual([]);
    expect(
      lines.some((l) => l.startsWith("failed: Pre-upgrade backup failed") && l.includes("409")),
    ).toBe(true);
    expect(lines.some((l) => l.includes("Nothing was changed: no migrations ran"))).toBe(true);
  });

  it("a failed deep health check rolls both services back and prints the restore command", async () => {
    const events: string[] = [];
    const { deps, calls, lines, recorded } = upgradeDeps(events, {
      deep: { ok: false, error: "cms_admin is missing 1 migration(s)" },
    });
    expect(await upgradeGcpInstall(TARGET, deps)).toBe(false);

    const deep = indexOf(events, /^health deep/);
    const rollbacks = events
      .slice(deep)
      .filter((e) => e.includes("update-traffic") && e.includes("--to-revisions"));
    // Newest first: the proxy (back to the gateway release it was), the
    // gateway, the admin.
    expect(rollbacks).toEqual([
      expect.stringContaining(
        `${PROXY} --region europe-west1 --project acme --to-revisions ${PROXY}-00001-old=100`,
      ),
      expect.stringContaining(
        `${GATEWAY} --region europe-west1 --project acme --to-revisions ${GATEWAY}-00001-old=100`,
      ),
      expect.stringContaining(
        `${ADMIN} --region europe-west1 --project acme --to-revisions ${ADMIN}-00001-old=100`,
      ),
    ]);
    // The audit job follows the admin back to its prior image (#875).
    const jobBack = events
      .slice(deep)
      .filter((e) => e.startsWith("gcloud run jobs update caelo-production-audit "));
    expect(jobBack).toEqual([expect.stringContaining(`--image=${OLD_ADMIN_IMAGE}`)]);
    // ... and so does the capture job (#1217).
    const captureBack = events
      .slice(deep)
      .filter((e) => e.startsWith("gcloud run jobs update caelo-production-capture "));
    expect(captureBack).toEqual([expect.stringContaining(`--image=${OLD_ADMIN_IMAGE}`)]);
    expect(recorded.digests).toEqual([]);
    expect(recorded.contract).toEqual([]);
    const restore = `gcloud sql backups restore ${BACKUP_ID} --restore-instance=${SQL} --project=acme`;
    expect(lines.some((l) => l.startsWith("warn:") && l.includes(restore))).toBe(true);
    // The rollback is the end: retired bindings stay until a healthy roll.
    expect(calls.some((c) => c.includes("remove-iam-policy-binding"))).toBe(false);
  });

  it("#883 review: reports rolledBack structurally — true only when every pin back succeeded", async () => {
    const deep = { ok: false as const, error: "cms_admin is missing 1 migration(s)" };
    const back = upgradeDeps([], { deep });
    expect(await upgradeGcpInstallOutcome(TARGET, back.deps)).toEqual({
      ok: false,
      rolledBack: true,
    });

    // The gateway's pin back fails: the previous release does NOT serve.
    const stuck = upgradeDeps([], {
      deep,
      overrides: [[new RegExp(`update-traffic ${GATEWAY} .*--to-revisions`), fail("503")]],
    });
    expect(await upgradeGcpInstallOutcome(TARGET, stuck.deps)).toEqual({
      ok: false,
      rolledBack: false,
    });

    // Nothing rolled (migrations failed): no rollback, so not rolled back.
    const early = upgradeDeps([]);
    expect(
      await upgradeGcpInstallOutcome(TARGET, {
        ...early.deps,
        migrate: async () => ({ ok: false, error: "boom" }),
      }),
    ).toEqual({ ok: false, rolledBack: false });

    expect(await upgradeGcpInstallOutcome(TARGET, upgradeDeps([]).deps)).toEqual({ ok: true });
  });

  it("sets up the converge job as the install's provisioner after the upgrader (#819)", async () => {
    const events: string[] = [];
    const { deps, lines } = upgradeDeps(events);
    expect(await upgradeGcpInstall(TARGET, deps)).toBe(true);
    const upgrader = indexOf(events, /^gcloud run jobs deploy caelo-production-upgrader /);
    const converge = indexOf(events, /^gcloud run jobs deploy caelo-production-converge /);
    expect(upgrader).toBeLessThan(converge);
    expect(events[converge]).toContain(
      "--service-account=caelo-provisioner@acme.iam.gserviceaccount.com",
    );
    expect(events[converge]).toContain(`--image=registry/ops@sha256:${"c".repeat(64)}`);
    expect(lines.some((l) => l.startsWith("done: Converge job ready"))).toBe(true);
  });

  it("a failed converge-job setup leaves the converge incomplete and CAELO_CONVERGE_JOB as it was", async () => {
    const events: string[] = [];
    const { deps, recorded, lines } = upgradeDeps(events, {
      overrides: [[/^run jobs deploy caelo-production-converge /, fail("PERMISSION_DENIED")]],
    });
    expect(await upgradeGcpInstall(TARGET, deps)).toBe(true);
    expect(recorded.contract).toEqual([]);
    expect(lines.some((l) => l.includes("Converge job not set up"))).toBe(true);
    expect(
      events.some((e) => /services update caelo-production-admin.*CAELO_CONVERGE_JOB=/.test(e)),
    ).toBe(false);
  });

  it("#883 review: an install without caelo-provisioner still records the contract; its admin keeps the terminal path", async () => {
    const events: string[] = [];
    const { deps, recorded, lines } = upgradeDeps(events, {
      overrides: [
        [
          /^iam service-accounts describe caelo-provisioner@/,
          fail("ERROR: NOT_FOUND: Unknown service account"),
        ],
        // A project without the default network's open rules: nothing
        // else keeps this converge incomplete.
        [/^compute firewall-rules list/, ok("[]")],
      ],
    });
    expect(await upgradeGcpInstall(TARGET, deps)).toBe(true);
    // Not blocked forever: the converge is complete without the job.
    expect(recorded.contract).toEqual([TARGET.infraContractVersion]);
    expect(lines.some((l) => l.includes("no caelo-provisioner"))).toBe(true);
    expect(lines.some((l) => l.includes("Converge job not set up"))).toBe(false);
    // No job, so no CAELO_CONVERGE_JOB: the admin routes such releases to the terminal.
    expect(events.some((e) => /^gcloud run jobs deploy caelo-production-converge /.test(e))).toBe(
      false,
    );
    expect(
      events.some((e) => /services update caelo-production-admin.*CAELO_CONVERGE_JOB=/.test(e)),
    ).toBe(false);
  });

  it("reports its backup and rollback targets before relying on them (#819 checkpoint)", async () => {
    const events: string[] = [];
    const { deps } = upgradeDeps(events);
    const seen: string[] = [];
    expect(
      await upgradeGcpInstall(TARGET, {
        ...deps,
        onCheckpoint: (c) => {
          if (c.priorRevisions) events.push(`checkpoint revisions ${c.priorRevisions.admin}`);
          if (c.backup) events.push(`checkpoint backup ${c.backup.backupId}`);
          seen.push(Object.keys(c).join(","));
        },
      }),
    ).toBe(true);
    expect(seen).toEqual(["priorRevisions", "backup"]);
    const revisions = indexOf(events, /^checkpoint revisions caelo-production-admin-aaa-00001-old/);
    const backup = indexOf(events, /^gcloud sql backups create/);
    const saved = indexOf(events, new RegExp(`^checkpoint backup ${BACKUP_ID}`));
    const migrate = indexOf(events, /^migrate /);
    expect(revisions).toBeLessThan(backup);
    expect(backup).toBeLessThan(saved);
    expect(saved).toBeLessThan(migrate);
  });

  it("a resumed run keeps the interrupted run's backup and rolls back onto what served before it (#819)", async () => {
    const events: string[] = [];
    const { deps, lines } = upgradeDeps(events, {
      deep: { ok: false, error: "unhealthy" },
    });
    const before = {
      admin: `${ADMIN}-00000-before`,
      gateway: `${GATEWAY}-00000-before`,
      "mcp-auth-proxy": `${PROXY}-00000-before`,
    };
    expect(
      await upgradeGcpInstall(TARGET, {
        ...deps,
        resume: {
          backup: { projectId: "acme", instance: SQL, backupId: "1759999999999" },
          priorRevisions: before,
        },
        onCheckpoint: () => events.push("checkpoint"),
      }),
    ).toBe(false);
    expect(events.some((e) => /sql backups create/.test(e))).toBe(false);
    expect(events).not.toContain("checkpoint");
    expect(lines).toContain(
      "info: Continuing an interrupted update: keeping its pre-upgrade backup 1759999999999.",
    );
    const rollbacks = events.filter((e) => e.includes("--to-revisions"));
    expect(rollbacks).toEqual([
      expect.stringContaining(`--to-revisions ${before["mcp-auth-proxy"]}=100`),
      expect.stringContaining(`--to-revisions ${before.gateway}=100`),
      expect.stringContaining(`--to-revisions ${before.admin}=100`),
    ]);
  });

  it("#1328 — a checkpoint without the proxy's revision (an older release wrote it) keeps the planned one", async () => {
    const events: string[] = [];
    const { deps } = upgradeDeps(events, { deep: { ok: false, error: "unhealthy" } });
    const before = { admin: `${ADMIN}-00000-before`, gateway: `${GATEWAY}-00000-before` };
    expect(
      await upgradeGcpInstall(TARGET, {
        ...deps,
        resume: {
          backup: { projectId: "acme", instance: SQL, backupId: "1759999999999" },
          priorRevisions: before,
        },
      }),
    ).toBe(false);
    expect(events.filter((e) => e.includes("--to-revisions"))).toEqual([
      expect.stringContaining(`--to-revisions ${PROXY}-00001-old=100`),
      expect.stringContaining(`--to-revisions ${before.gateway}=100`),
      expect.stringContaining(`--to-revisions ${before.admin}=100`),
    ]);
  });

  it("revokes public_role's Cloud SQL role memberships before the migrations audit them (#633)", async () => {
    const events: string[] = [];
    const { deps, lines } = upgradeDeps(events);
    expect(await upgradeGcpInstall(TARGET, deps)).toBe(true);
    const revoke = indexOf(
      events,
      /^gcloud sql users assign-roles public_role --instance=caelo-production-pg-abc --type=BUILT_IN --revoke-existing-roles --project=acme/,
    );
    expect(indexOf(events, /^gcloud sql backups create/)).toBeLessThan(revoke);
    expect(revoke).toBeLessThan(indexOf(events, /^migrate /));
    expect(lines).toContain(
      "done: public_role holds no database roles (no database roles left on caelo-production-pg-abc)",
    );
  });

  it("a refused public_role revoke stops the upgrade before migrations and any roll (#633)", async () => {
    const events: string[] = [];
    const { deps, calls, lines } = upgradeDeps(events, {
      overrides: [[/^sql users assign-roles public_role/, fail("PERMISSION_DENIED: no")]],
    });
    expect(await upgradeGcpInstall(TARGET, deps)).toBe(false);
    expect(events.some((e) => e.startsWith("migrate"))).toBe(false);
    expect(calls.filter((c) => APP_ROLL_WRITE.test(c))).toEqual([]);
    expect(lines).toContain(
      "failed: public_role's role memberships could not be revoked. Aborting upgrade.",
    );
  });

  it("on gcp, runs both contract steps: the public_role revoke (3) and the URL-map redirects role (4)", async () => {
    const events: string[] = [];
    const { deps, lines } = upgradeDeps(events, {
      overrides: [[/^iam roles describe/, fail("NOT_FOUND: role")]],
    });
    expect(await upgradeGcpInstall({ ...GCP_TARGET, infraContractVersion: 4 }, deps)).toBe(true);
    const revoke = indexOf(events, /^gcloud sql users assign-roles public_role /);
    const role = indexOf(
      events,
      /^gcloud iam roles create caelo_production_urlMapRedirects --project=acme .*--permissions=compute\.urlMaps\.list,/,
    );
    const grant = indexOf(
      events,
      /^gcloud projects add-iam-policy-binding acme --member=serviceAccount:caelo-production-run-sa@acme\.iam\.gserviceaccount\.com --role=projects\/acme\/roles\/caelo_production_urlMapRedirects /,
    );
    expect(revoke).toBeLessThan(indexOf(events, /^migrate /));
    expect(role).toBeLessThan(grant);
    expect(grant).toBeLessThan(indexOf(events, /^migrate /));
    expect(lines).toContain(
      "done: URL-map redirects role ready (projects/acme/roles/caelo_production_urlMapRedirects)",
    );
    // (This fake models gcp-firebase's listings, so gcp-only steps such as
    // the default-firewall cleanup stay incomplete; the role step is not.)
    expect(lines.some((l) => l.includes("URL-map redirects role not set up"))).toBe(false);
  });

  it("on gcp, a refused redirects role leaves the converge incomplete: contract 4 is not recorded", async () => {
    const events: string[] = [];
    const { deps, lines, recorded } = upgradeDeps(events, {
      overrides: [
        [/^iam roles describe/, fail("NOT_FOUND: role")],
        [/^iam roles create/, fail("PERMISSION_DENIED: iam.roles.create")],
      ],
    });
    expect(await upgradeGcpInstall({ ...GCP_TARGET, infraContractVersion: 4 }, deps)).toBe(true);
    expect(lines.some((l) => l.startsWith("warned: URL-map redirects role not set up"))).toBe(true);
    expect(recorded.contract).toEqual([]);
  });

  it("#806/#1328 — the rolls carry remote MCP: identity env, the proxy's client file and timeout", async () => {
    const events: string[] = [];
    const { deps, calls } = upgradeDeps(events);
    expect(await upgradeGcpInstall(TARGET, deps)).toBe(true);
    const rolls = calls.filter((c) =>
      /^run services update \S+ --region europe-west1 .*--image/.test(c),
    );
    const admin = rolls.find((c) => c.startsWith(`run services update ${ADMIN} `)) ?? "";
    const gateway = rolls.find((c) => c.startsWith(`run services update ${GATEWAY} `)) ?? "";
    const proxy = rolls.find((c) => c.startsWith(`run services update ${PROXY} `)) ?? "";
    expect(admin).toContain(
      `CAELO_IAP_AUDIENCE=/projects/42/locations/europe-west1/services/${ADMIN}`,
    );
    // E13 a: the MCP address stays the run.app URL of the service that was the gateway.
    expect(admin).toContain(`CAELO_MCP_PUBLIC_URL=https://${PROXY}-xyz.a.run.app`);
    // The Firebase rewrite follows the data gateway.
    expect(admin).toContain(`CAELO_GATEWAY_SERVICE=${GATEWAY}`);
    expect(proxy).toContain(`--image ${IMAGES["mcp-auth-proxy"].imageRef}`);
    expect(proxy).toContain(`CAELO_ADMIN_URL=https://${ADMIN}-xyz.a.run.app`);
    expect(proxy).toContain(`CAELO_MCP_PUBLIC_URL=https://${PROXY}-xyz.a.run.app`);
    expect(proxy).toContain(
      "/secrets/operator-oauth-client/client.json=caelo-production-operator-oauth-client:latest",
    );
    expect(proxy).toContain("--timeout=3600");
    // The gateway carries none of it any more.
    expect(gateway).not.toContain("CAELO_MCP_PUBLIC_URL=");
    expect(gateway).not.toContain("operator-oauth-client");
    expect(gateway).not.toContain("--timeout");
    expect(admin).not.toContain("--timeout");
    // No extra revision: everything rides the image rolls.
    expect(calls.filter((c) => /^run services update /.test(c))).toHaveLength(3);
  });

  it("#1328 — the gcp-firebase proxy roll leaves the VPC, drops every database login and forwards to the data gateway", async () => {
    const events: string[] = [];
    const { deps, calls } = upgradeDeps(events);
    expect(await upgradeGcpInstall(TARGET, deps)).toBe(true);
    const proxy =
      calls.find((c) => new RegExp(`^run services update ${PROXY} .*--image`).test(c)) ?? "";
    expect(proxy).toContain(
      "--service-account=caelo-production-mcp-proxy-sa@acme.iam.gserviceaccount.com",
    );
    expect(proxy).toContain("--clear-network");
    expect(proxy).toContain("CAELO_REMOTE_MCP=available");
    expect(proxy).toContain(`CAELO_INTERIM_FORWARD_ORIGIN=https://${GATEWAY}-xyz.a.run.app`);
    const removedEnv = proxy.match(/--remove-env-vars=(\S+)/)?.[1]?.split(",") ?? [];
    const removedSecrets = proxy.match(/--remove-secrets=(\S+)/)?.[1]?.split(",") ?? [];
    expect(removedEnv).toContain("PUBLIC_DATABASE_URL");
    expect(removedSecrets).toEqual(
      expect.arrayContaining(["PUBLIC_DATABASE_PASSWORD", "CAELO_STAGING_GATE_SECRET"]),
    );
    // The gateway keeps its VPC route to Cloud SQL.
    const gateway =
      calls.find((c) => new RegExp(`^run services update ${GATEWAY} .*--image`).test(c)) ?? "";
    expect(gateway).not.toContain("--clear-network");
  });

  it("#1328 — gcp-firebase: the pre-plan step copies the data gateway from the old gateway when it is missing", async () => {
    const events: string[] = [];
    const { deps, calls, lines } = upgradeDeps(events, {
      overrides: [
        [
          new RegExp(`^run services describe ${GATEWAY} .*metadata\\.name`),
          fail(`ERROR: Cannot find service [${GATEWAY}]. NOT_FOUND`),
        ],
      ],
    });
    expect(await upgradeGcpInstall(TARGET, deps)).toBe(true);
    const replace = indexOf(events, /^gcloud run services replace /);
    expect(replace).toBeLessThan(indexOf(events, /^gcloud sql backups create/));
    expect(lines).toContain(
      `info:   created: Cloud Run service ${GATEWAY} (the visitor gateway) (copied from ${PROXY})`,
    );
    // Nothing else is deployed before the plan: the proxy is rolled later.
    expect(calls.some((c) => /^run deploy /.test(c))).toBe(false);
  });

  it("#1328 — gcp-firebase: an existing data gateway makes the pre-plan step a no-op", async () => {
    const events: string[] = [];
    const { deps, calls } = upgradeDeps(events);
    expect(await upgradeGcpInstall(TARGET, deps)).toBe(true);
    expect(calls.some((c) => /^run services replace |^run deploy /.test(c))).toBe(false);
  });

  it("#1328 — a failed pre-plan step stops before the backup, with nothing rolled", async () => {
    const events: string[] = [];
    const { deps, calls, lines } = upgradeDeps(events, {
      overrides: [[/^secrets add-iam-policy-binding/, fail("PERMISSION_DENIED: setIamPolicy")]],
    });
    expect(await upgradeGcpInstall(TARGET, deps)).toBe(false);
    expect(calls.some((c) => /^sql backups create/.test(c))).toBe(false);
    expect(calls.filter((c) => APP_ROLL_WRITE.test(c))).toEqual([]);
    expect(events.some((e) => e.startsWith("migrate"))).toBe(false);
    expect(
      lines.some((l) => l.startsWith("failed: The services this release runs could not be set up")),
    ).toBe(true);
  });

  it("#1328 — gcp: the proxy is deployed only after its image's signature verifies", async () => {
    const missingProxy: [RegExp, Answer] = [
      new RegExp(`^run services describe ${GCP_PROXY} .*metadata\\.name`),
      fail(`ERROR: Cannot find service [${GCP_PROXY}]. NOT_FOUND`),
    ];
    const events: string[] = [];
    const { deps } = upgradeDeps(events, { overrides: [missingProxy] });
    expect(
      await upgradeGcpInstall(GCP_TARGET, {
        ...deps,
        verifyImages: async (images) => {
          events.push(`verify ${images.map((i) => i.slug).join(",")}`);
          return true;
        },
      }),
    ).toBe(true);
    const verify = indexOf(events, /^verify mcp-auth-proxy$/);
    const deploy = indexOf(events, new RegExp(`^gcloud run deploy ${GCP_PROXY} `));
    expect(verify).toBeLessThan(deploy);
    expect(events[deploy]).toContain(`--image=${IMAGES["mcp-auth-proxy"].imageRef}`);
    expect(events[deploy]).toContain("--ingress=internal-and-cloud-load-balancing");
    expect(deploy).toBeLessThan(indexOf(events, /^gcloud sql backups create/));

    // A signature that does not verify: nothing is deployed, nothing backed up.
    const refused: string[] = [];
    const bad = upgradeDeps(refused, { overrides: [missingProxy] });
    expect(
      await upgradeGcpInstall(GCP_TARGET, {
        ...bad.deps,
        verifyImages: async (images) => !images.some((i) => i.slug === "mcp-auth-proxy"),
      }),
    ).toBe(false);
    expect(bad.calls.some((c) => /^run deploy /.test(c))).toBe(false);
    expect(bad.calls.some((c) => /^sql backups create/.test(c))).toBe(false);
  });

  it("moves the gateway to request-based CPU in its image roll; the admin keeps its CPU", async () => {
    const events: string[] = [];
    const { deps, calls } = upgradeDeps(events);
    expect(await upgradeGcpInstall(TARGET, deps)).toBe(true);
    const rolls = calls.filter((c) =>
      /^run services update \S+ --region europe-west1 .*--image/.test(c),
    );
    const admin = rolls.find((c) => c.startsWith(`run services update ${ADMIN} `)) ?? "";
    const gateway = rolls.find((c) => c.startsWith(`run services update ${GATEWAY} `)) ?? "";
    const proxy = rolls.find((c) => c.startsWith(`run services update ${PROXY} `)) ?? "";
    expect(gateway).toContain("--cpu-throttling");
    expect(proxy).toContain("--cpu-throttling");
    expect(admin).not.toContain("cpu-throttling");
    expect(calls.filter((c) => /^run services update /.test(c))).toHaveLength(3);
  });

  it("#806/#1328 — on gcp, moves the remote-MCP paths and the Cloud Armor rule to the proxy's backend before the roll", async () => {
    const events: string[] = [];
    // The #806 shape: the discovery paths on the gateway's rule, the MCP
    // rule on the gateway's policy.
    const gatewayBackend =
      "https://www.googleapis.com/compute/v1/projects/acme/global/backendServices/caelo-production-gateway-backend-1";
    const urlMap = {
      name: "caelo-production-url-map-1",
      hostRules: [{ hosts: ["acme.com"], pathMatcher: "public" }],
      pathMatchers: [
        {
          name: "public",
          pathRules: [
            {
              paths: [
                "/api/*",
                "/.well-known/oauth-protected-resource/*",
                "/.well-known/oauth-authorization-server/*",
              ],
              service: gatewayBackend,
            },
          ],
        },
      ],
    };
    const r = MCP_ARMOR_RULE;
    const gatewayMcpRule = {
      priority: r.priority,
      action: r.action,
      match: { expr: { expression: r.expression } },
      rateLimitOptions: {
        rateLimitThreshold: { count: r.count, intervalSec: r.intervalSec },
        conformAction: r.conformAction,
        exceedAction: r.exceedAction,
        enforceOnKey: r.enforceOnKey,
      },
    };
    let proxyPolicyCreated = false;
    const puts: string[] = [];
    const { deps, lines } = upgradeDeps(events, {
      overrides: [
        [/^compute url-maps list/, ok(JSON.stringify([urlMap]))],
        [/^compute security-policies list/, ok("caelo-production-waf-1\n")],
        [
          /^compute security-policies describe caelo-production-mcp-auth-proxy-armor /,
          () =>
            proxyPolicyCreated
              ? ok(JSON.stringify({ rules: [] }))
              : fail("ERROR: The resource 'caelo-production-mcp-auth-proxy-armor' was not found"),
        ],
        [
          /^compute security-policies create caelo-production-mcp-auth-proxy-armor /,
          () => {
            proxyPolicyCreated = true;
            return ok();
          },
        ],
        [
          /^compute security-policies describe caelo-production-waf-1 /,
          ok(JSON.stringify({ rules: [gatewayMcpRule] })),
        ],
        [/^compute (network-endpoint-groups|backend-services) describe/, fail("NOT_FOUND")],
      ],
    });
    const recordingHttp: HttpFetch = async (url, init) => {
      if (init.method === "PUT" && url.includes("/urlMaps/")) puts.push(init.body ?? "");
      return http(url, init);
    };
    expect(await upgradeGcpInstall(GCP_TARGET, { ...deps, http: recordingHttp })).toBe(true);
    const armor = indexOf(
      events,
      /^gcloud compute security-policies rules create 900 --security-policy=caelo-production-mcp-auth-proxy-armor /,
    );
    const neg = indexOf(
      events,
      /^gcloud compute network-endpoint-groups create caelo-production-mcp-auth-proxy-neg .*--cloud-run-service=caelo-production-mcp-auth-proxy/,
    );
    const backend = indexOf(
      events,
      /^gcloud compute backend-services create caelo-production-mcp-auth-proxy-backend .*--security-policy=caelo-production-mcp-auth-proxy-armor/,
    );
    const retire = indexOf(
      events,
      /^gcloud compute security-policies rules delete 900 --security-policy=caelo-production-waf-1 /,
    );
    expect(puts).toHaveLength(1);
    const put = JSON.parse(puts[0] as string) as typeof urlMap;
    const rules = put.pathMatchers[0]?.pathRules ?? [];
    expect(rules).toEqual([
      { paths: ["/api/*"], service: gatewayBackend },
      {
        paths: [
          "/api/mcp/*",
          "/.well-known/oauth-protected-resource/*",
          "/.well-known/oauth-authorization-server/*",
        ],
        service:
          "https://www.googleapis.com/compute/v1/projects/acme/global/backendServices/caelo-production-mcp-auth-proxy-backend",
      },
    ]);
    expect(lines).toContain("done: Remote-MCP load-balancer route ready");
    // Proxy policy before its backend, the old gateway rule only once the
    // URL map no longer sends MCP there; all before the migrations.
    expect(armor).toBeLessThan(backend);
    expect(neg).toBeLessThan(backend);
    expect(backend).toBeLessThan(retire);
    expect(retire).toBeLessThan(indexOf(events, /^migrate /));
  });

  it("on gcp-firebase there is no URL map: no redirects role", async () => {
    const events: string[] = [];
    const { deps, calls } = upgradeDeps(events);
    expect(await upgradeGcpInstall(TARGET, deps)).toBe(true);
    expect(calls.some((c) => c.includes("urlMapRedirects"))).toBe(false);
  });

  it("runs the keyless-provisioner step as the first converge step; its failure stops before migrations", async () => {
    const events: string[] = [];
    const { deps, calls } = upgradeDeps(events);
    const ok = await upgradeGcpInstall(TARGET, {
      ...deps,
      provisionerIdentity: async () => {
        events.push("provisioner identity");
        return false;
      },
    });
    expect(ok).toBe(false);
    expect(indexOf(events, /^gcloud sql backups create/)).toBeLessThan(
      indexOf(events, /^provisioner identity/),
    );
    expect(events.some((e) => e.startsWith("migrate"))).toBe(false);
    expect(
      calls.filter(
        (c) => (CONVERGE_WRITE.test(c) && !PRE_PLAN_WRITE.test(c)) || APP_ROLL_WRITE.test(c),
      ),
    ).toEqual([]);
  });

  it("a deep health probe that throws still rolls back", async () => {
    const events: string[] = [];
    const { deps, recorded } = upgradeDeps(events);
    const throwing: HealthProbe = {
      baseline: async () => ({ ok: true, detail: "" }),
      deep: async () => {
        throw new Error("socket hang up");
      },
    };
    expect(
      await upgradeGcpInstall(TARGET, {
        ...deps,
        healthProbe: async () => ({ ok: true, probe: throwing }),
      }),
    ).toBe(false);
    expect(events.filter((e) => e.includes("--to-revisions"))).toHaveLength(3);
    expect(recorded.digests).toEqual([]);
  });

  it("a health baseline that can't reach the install stops before the migrations", async () => {
    const events: string[] = [];
    const { deps, calls } = upgradeDeps(events);
    const unreachable: HealthProbe = {
      baseline: async () => ({ ok: false, error: "admin unreachable at https://admin.acme.com" }),
      deep: async () => ({ ok: true, detail: "" }),
    };
    expect(
      await upgradeGcpInstall(TARGET, {
        ...deps,
        healthProbe: async () => ({ ok: true, probe: unreachable }),
      }),
    ).toBe(false);
    expect(events.some((e) => e.startsWith("migrate"))).toBe(false);
    expect(calls.some((c) => APP_ROLL_WRITE.test(c))).toBe(false);
  });

  it("#732 — opens a load-balancer-only gcp-firebase gateway in converge, before the baseline and migrations", async () => {
    const events: string[] = [];
    const internalGateway = serviceJson(
      "registry/gateway@sha256:old",
      JSON.parse(GATEWAY_JSON).spec.template.spec.containers[0].env,
      "internal-and-cloud-load-balancing",
    );
    const { deps, lines } = upgradeDeps(events, {
      overrides: [[new RegExp(`describe ${GATEWAY} .*--format=json`), ok(internalGateway)]],
    });
    expect(await upgradeGcpInstall(TARGET, deps)).toBe(true);
    const ingress = indexOf(
      events,
      new RegExp(`^gcloud run services update ${GATEWAY} .*--ingress=all`),
    );
    expect(ingress).toBeLessThan(indexOf(events, /^health baseline/));
    expect(ingress).toBeLessThan(indexOf(events, /^migrate /));
    // Its own update: the image roll does not carry it (no new revision).
    expect(events.filter((e) => e.includes("--ingress=all"))).toHaveLength(1);
    expect(lines).toContain(
      `info:   applied: ingress internal-and-cloud-load-balancing → all on ${GATEWAY} (the gcp-firebase stack's gateway ingress (#650); Firebase Hosting and the health check reach its run.app URL)`,
    );
  });

  it("#732 — leaves a gateway that is already open alone, and never touches the gcp gateway's ingress", async () => {
    for (const target of [TARGET, GCP_TARGET]) {
      const events: string[] = [];
      const { deps } = upgradeDeps(events);
      await upgradeGcpInstall(target, deps);
      expect(events.some((e) => e.includes("--ingress"))).toBe(false);
    }
  });

  it("#734 — tells the health probe when converge just changed access, so its baseline waits", async () => {
    const seen: boolean[] = [];
    const events: string[] = [];
    const { deps } = upgradeDeps(events);
    await upgradeGcpInstall(TARGET, {
      ...deps,
      healthProbe: async (_plan, context) => {
        seen.push(context.accessJustChanged);
        return { ok: true, probe: fakeHealth(events) };
      },
    });
    // The fake install's empty IAM policies make converge add every binding.
    expect(seen).toEqual([true]);
  });

  it("#733 — a gateway answering Google's HTML 404 stops the upgrade before migrations and any roll", async () => {
    const events: string[] = [];
    const { deps, calls, lines } = upgradeDeps(events);
    const htmlGateway: HttpFetch = async (url) => {
      const [status, text] = url.includes(":signJwt")
        ? [200, JSON.stringify({ signedJwt: "signed.jwt" })]
        : url.includes("admin")
          ? [200, JSON.stringify({ ok: true, version: "0.10.20" })]
          : [404, "<html><title>Error 404 (Not Found)!!1</title></html>"];
      return { ok: status < 400, status, text: async () => text };
    };
    expect(
      await upgradeGcpInstall(TARGET, {
        ...deps,
        healthProbe: async () => ({
          ok: true,
          probe: createIapHealthProbe(
            {
              provider: "gcp-firebase",
              projectId: "acme",
              domain: "acme.com",
              adminServiceUrl: `https://${ADMIN}-xyz.a.run.app`,
              gatewayServiceUrl: `https://${GATEWAY}-xyz.a.run.app`,
              mcpAuthProxyServiceUrl: `https://${PROXY}-xyz.a.run.app`,
            },
            { run: deps.run, http: htmlGateway, sleep: noSleep, accessJustChanged: false },
          ),
        }),
      }),
    ).toBe(false);
    expect(events.some((e) => e.startsWith("migrate"))).toBe(false);
    expect(calls.some((c) => APP_ROLL_WRITE.test(c))).toBe(false);
    expect(lines.some((l) => l.includes("answered HTTP 404 without JSON"))).toBe(true);
  });

  it("--skip-health-check rolls without a probe", async () => {
    const events: string[] = [];
    const { deps } = upgradeDeps(events);
    let asked = false;
    const ok = await upgradeGcpInstall(
      { ...TARGET, skipHealthCheck: true },
      {
        ...deps,
        healthProbe: async () => {
          asked = true;
          return { ok: false, error: "never" };
        },
      },
    );
    expect(ok).toBe(true);
    expect(asked).toBe(false);
  });
});

const INSTALL: AppRollInstall = {
  provider: "gcp-firebase",
  projectId: "acme",
  region: "europe-west1",
  env: "production",
  domain: "acme.com",
  stagingHost: "staging.acme.com",
  credentials: "operator",
};

async function plannedRoll(run: GcloudRunner): Promise<AppRollPlan> {
  const planned = await planAppRoll(INSTALL, IMAGES, run, { secretVolumes: true });
  if (!planned.ok) throw new Error(planned.error);
  return planned.plan;
}

const BACKUP = { projectId: "acme", instance: SQL, backupId: BACKUP_ID };

describe("app-roll and converge stay on their side", () => {
  it("app-roll alone (the upgrader job's path) never changes IAM, secrets or APIs", async () => {
    const events: string[] = [];
    const { run, calls } = fakeInstall(events);
    const plan = await plannedRoll(run);
    const result = await executeAppRoll(
      { plan, backup: BACKUP, targetVersion: "0.11.0", migrationsContract: false },
      {},
      {
        run,
        sleep: noSleep,
        reporter: recordingReporter().reporter,
        migrate: async () => ({ ok: true }),
        health: fakeHealth(events),
        resolveOpsImage: async () => `registry/ops@sha256:${"c".repeat(64)}`,
        recordDigests: async () => {},
      },
    );
    expect(result).toEqual({ ok: true, digests: DIGEST });
    expect(calls.filter((c) => CONVERGE_WRITE.test(c))).toEqual([]);
    expect(calls.filter((c) => /^run services update /.test(c))).toHaveLength(3);
  });

  it("#1338: without a converge, a plan whose services dial the database's IP stops before migrations", async () => {
    const events: string[] = [];
    const { run, calls } = fakeInstall(events);
    const plan = { ...(await plannedRoll(run)), databaseHostPending: true };
    const { reporter, lines } = recordingReporter();
    let migrated = false;
    const result = await executeAppRoll(
      { plan, backup: BACKUP, targetVersion: "0.11.0", migrationsContract: false },
      {},
      {
        run,
        sleep: noSleep,
        reporter,
        migrate: async () => {
          migrated = true;
          return { ok: true };
        },
        health: fakeHealth(events),
        resolveOpsImage: async () => `registry/ops@sha256:${"c".repeat(64)}`,
        recordDigests: async () => {},
      },
    );
    expect(result).toEqual({ ok: false, phase: "migrations", migrated: false, rolledBack: false });
    expect(migrated).toBe(false);
    expect(calls.filter((c) => APP_ROLL_WRITE.test(c))).toEqual([]);
    expect(lines.join("\n")).toContain("verify-full TLS");
  });

  it("converge alone never rolls a service or runs migrations", async () => {
    const events: string[] = [];
    const { run, calls } = fakeInstall(events);
    const plan = await plannedRoll(run);
    const session = startConverge(plan, "owner@acme.com", {
      run,
      sleep: noSleep,
      http,
      reporter: recordingReporter().reporter,
    });
    expect(await session.beforeAppRoll()).toBe(true);
    const between = await session.hooks.afterMigrations?.();
    expect(between?.ok).toBe(true);
    expect((await session.hooks.beforeRoll?.("gateway"))?.ok).toBe(true);
    await session.afterAppRoll();
    expect(calls.filter((c) => APP_ROLL_WRITE.test(c))).toEqual([]);
    // It did converge something: the stack's IAM bindings, and the API the
    // health check signs its IAP credential through.
    expect(calls.some((c) => CONVERGE_WRITE.test(c))).toBe(true);
    expect(calls).toContain("services enable iamcredentials.googleapis.com --project=acme");
  });

  it("a failed gateway roll goes back to the prior admin revision and undoes the gateway hook", async () => {
    const events: string[] = [];
    const { run, calls } = fakeInstall(events, [
      [new RegExp(`^run services update ${GATEWAY} `), fail("Revision failed to become ready")],
    ]);
    const plan = await plannedRoll(run);
    const undone: string[] = [];
    const result = await executeAppRoll(
      { plan, backup: BACKUP, targetVersion: null, migrationsContract: null },
      { afterRollback: async (slug) => void undone.push(slug) },
      {
        run,
        sleep: noSleep,
        reporter: recordingReporter().reporter,
        migrate: async () => ({ ok: true }),
        health: fakeHealth(events),
        resolveOpsImage: async () => `registry/ops@sha256:${"c".repeat(64)}`,
        recordDigests: async () => {
          throw new Error("must not record");
        },
      },
    );
    expect(result).toEqual({ ok: false, phase: "roll", migrated: true, rolledBack: true });
    expect(calls).toContain(
      `run services update-traffic ${ADMIN} --region europe-west1 --project acme --to-revisions ${ADMIN}-00001-old=100 --quiet`,
    );
    expect(undone).toEqual(["gateway", "admin"]);
  });

  it("a migration failure moves no traffic and names the backup", async () => {
    const events: string[] = [];
    const { run, calls } = fakeInstall(events);
    const plan = await plannedRoll(run);
    const { reporter, lines } = recordingReporter();
    const result = await executeAppRoll(
      { plan, backup: BACKUP, targetVersion: null, migrationsContract: true },
      {},
      {
        run,
        reporter,
        migrate: async () => ({ ok: false, error: "migrate-admin-exec: exit 1" }),
        health: fakeHealth(events),
        resolveOpsImage: async () => `registry/ops@sha256:${"c".repeat(64)}`,
        recordDigests: async () => {},
      },
    );
    expect(result).toEqual({ ok: false, phase: "migrations", migrated: true, rolledBack: false });
    expect(calls.filter((c) => APP_ROLL_WRITE.test(c))).toEqual([]);
    expect(
      lines.some((l) => l.includes("contract-type") && l.includes(restoreCommand(BACKUP))),
    ).toBe(true);
  });
});

describe("needsConverge", () => {
  it("is true for an install that never recorded a contract version", () => {
    expect(needsConverge({}, 1)).toBe(true);
  });
  it("is true while the recorded version is behind the release's", () => {
    expect(needsConverge({ infraContractVersion: 1 }, 2)).toBe(true);
  });
  it("is false once the install is at (or past) the release's version", () => {
    expect(needsConverge({ infraContractVersion: 2 }, 2)).toBe(false);
    expect(needsConverge({ infraContractVersion: 3 }, 2)).toBe(false);
  });
});

describe("takeSqlBackup", () => {
  it("backs up a gcp-firebase install's Cloud SQL instance and returns the backup id", async () => {
    const events: string[] = [];
    const { run, calls } = fakeInstall(events);
    const r = await takeSqlBackup(
      run,
      { projectId: "acme", env: "production", credentials: "operator" },
      "backup",
      () => new Date("2026-10-13T10:00:00Z"),
    );
    expect(r).toEqual({ ok: true, backup: BACKUP });
    expect(calls).toEqual([
      "sql instances list --project acme --filter name~^caelo-production-pg --format=value(name)",
      "sql backups create --instance caelo-production-pg-abc --project acme --description caelo-cms backup 2026-10-13T10:00:00.000Z",
      'sql backups list --instance caelo-production-pg-abc --project acme --filter=description="caelo-cms backup 2026-10-13T10:00:00.000Z" --format=value(id)',
    ]);
    expect(restoreCommand(BACKUP)).toBe(
      `gcloud sql backups restore ${BACKUP_ID} --restore-instance=${SQL} --project=acme`,
    );
  });

  it("fails loudly when the backup's id can't be found", async () => {
    const { run } = fakeInstall([], [[/^sql backups list/, ok("")]]);
    const r = await takeSqlBackup(
      run,
      { projectId: "acme", env: "production", credentials: "operator" },
      "backup",
    );
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.error).toContain("gcloud sql backups list --instance=caelo-production-pg-abc");
  });

  it("fails when the install has no Cloud SQL instance", async () => {
    const { run } = fakeInstall([], [[/^sql instances list/, ok("")]]);
    const r = await takeSqlBackup(
      run,
      { projectId: "acme", env: "production", credentials: "operator" },
      "backup",
    );
    expect(r).toEqual({
      ok: false,
      error: "Could not find the caelo-production-pg* Cloud SQL instance in project acme",
    });
  });

  it("reports expired credentials instead of a missing instance (#630)", async () => {
    const { run } = fakeInstall(
      [],
      [
        [
          /^sql instances list/,
          fail(
            "ERROR: (gcloud.sql.instances.list) Reauthentication failed. cannot prompt during non-interactive execution.",
          ),
        ],
      ],
    );
    const operator = await takeSqlBackup(
      run,
      { projectId: "acme", env: "production", credentials: "operator" },
      "backup",
    );
    expect(operator.ok).toBe(false);
    if (operator.ok) return;
    expect(operator.error).toContain("gcloud credentials expired");
    expect(operator.error).toContain("gcloud auth login");
    expect(operator.error).not.toContain("Could not find");
    const job = await takeSqlBackup(
      run,
      { projectId: "acme", env: "production", credentials: "job" },
      "backup",
    );
    expect(job.ok).toBe(false);
    if (job.ok) return;
    expect(job.error).toContain("rejected this job's credentials");
    expect(job.error).not.toContain("gcloud auth login");
  });
});
