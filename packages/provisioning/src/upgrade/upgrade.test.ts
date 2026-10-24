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
const GATEWAY = "caelo-production-gateway-bbb";
const SQL = "caelo-production-pg-abc";
const BACKUP_ID = "1760000000000";
const DIGEST = { admin: `sha256:${"a".repeat(64)}`, gateway: `sha256:${"b".repeat(64)}` };
const IMAGES: Record<RollSlug, ReleaseImage> = {
  admin: { digest: DIGEST.admin, imageRef: `registry/admin@${DIGEST.admin}` },
  gateway: { digest: DIGEST.gateway, imageRef: `registry/gateway@${DIGEST.gateway}` },
};

const secretRef = (name: string, secret: string) => ({
  name,
  valueFrom: { secretKeyRef: { name: `caelo-production-${secret}`, key: "latest" } },
});

/**
 * A described service, as `gcloud run services describe --format=json`
 * returns it. `ingress`: the service-level setting (#732).
 */
const serviceJson = (image: string, env: unknown[], ingress = "all") =>
  JSON.stringify({
    metadata: { annotations: { "run.googleapis.com/ingress": ingress } },
    spec: {
      template: {
        metadata: {
          annotations: {
            "run.googleapis.com/network-interfaces": JSON.stringify([
              { network: "caelo-production-vpc", subnetwork: "caelo-production-subnet" },
            ]),
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
    value: "postgresql://admin_role@10.20.0.3:5432/cms_admin?sslmode=require",
  },
  {
    name: "PUBLIC_ADMIN_DATABASE_URL",
    value: "postgresql://admin_role@10.20.0.3:5432/cms_public?sslmode=require",
  },
  secretRef("ADMIN_DATABASE_PASSWORD", "postgres-password"),
  secretRef("PUBLIC_ADMIN_DATABASE_PASSWORD", "postgres-password"),
]);
const GATEWAY_JSON = serviceJson("registry/gateway@sha256:old", [
  {
    name: "PUBLIC_DATABASE_URL",
    value: "postgresql://public_role@10.20.0.3:5432/cms_public?sslmode=require",
  },
  secretRef("PUBLIC_DATABASE_PASSWORD", "public-role-password"),
]);

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
    [/^run services list .*caelo-production-gateway/, ok(`${GATEWAY}\n`)],
    [/describe (\S+) .*revisionName/, (l) => ok(`${l.split(" ")[3]}-00001-old\n`)],
    [new RegExp(`describe ${ADMIN} .*--format=json`), ok(ADMIN_JSON)],
    [new RegExp(`describe ${GATEWAY} .*--format=json`), ok(GATEWAY_JSON)],
    [/describe (\S+) .*status\.url/, (l) => ok(`https://${l.split(" ")[3]}-xyz.a.run.app\n`)],
    [
      /^run jobs describe caelo-production-audit .*containers\[0\]\.image/,
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
  /^run services update |^run services update-traffic|jobs execute caelo-migrate|^run jobs update caelo-production-audit /;
/** Any gcloud call that changes something. */
const ANY_WRITE =
  /\b(create|update|update-traffic|delete|add-iam-policy-binding|remove-iam-policy-binding|set-iam-policy|execute|enable|add|restore)\b/;

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
    const firstConvergeWrite = indexOf(events, /^gcloud .*(add-iam-policy-binding|secrets create)/);
    const baseline = indexOf(events, /^health baseline/);
    const migrate = indexOf(events, /^migrate registry\/admin@/);
    const adminRoll = indexOf(events, new RegExp(`^gcloud run services update ${ADMIN} `));
    const gatewayRoll = indexOf(events, new RegExp(`^gcloud run services update ${GATEWAY} `));
    const deep = indexOf(events, /^health deep 0\.11\.0/);
    const digests = indexOf(events, /^record digests/);

    // Nothing writes before the backup.
    for (const e of events.slice(0, backup)) expect(e).not.toMatch(/^(migrate|record)/);
    for (const e of events.slice(0, backup).filter((e) => e.startsWith("gcloud "))) {
      expect(e.slice("gcloud ".length)).not.toMatch(ANY_WRITE);
    }
    expect(backup).toBeLessThan(firstConvergeWrite);
    expect(firstConvergeWrite).toBeLessThan(baseline);
    expect(baseline).toBeLessThan(migrate);
    expect(migrate).toBeLessThan(adminRoll);
    expect(adminRoll).toBeLessThan(gatewayRoll);
    expect(gatewayRoll).toBeLessThan(deep);
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

    const writes = calls.filter((c) => ANY_WRITE.test(c));
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
    expect(rollbacks).toEqual([
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
    const before = { admin: `${ADMIN}-00000-before`, gateway: `${GATEWAY}-00000-before` };
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

  it("#806 — the rolls carry remote MCP: identity env, the gateway's client file and timeout", async () => {
    const events: string[] = [];
    const { deps, calls } = upgradeDeps(events);
    expect(await upgradeGcpInstall(TARGET, deps)).toBe(true);
    const rolls = calls.filter((c) =>
      /^run services update \S+ --region europe-west1 .*--image/.test(c),
    );
    const admin = rolls.find((c) => c.startsWith(`run services update ${ADMIN} `)) ?? "";
    const gateway = rolls.find((c) => c.startsWith(`run services update ${GATEWAY} `)) ?? "";
    expect(admin).toContain(
      `CAELO_IAP_AUDIENCE=/projects/42/locations/europe-west1/services/${ADMIN}`,
    );
    expect(admin).toContain(`CAELO_MCP_PUBLIC_URL=https://${GATEWAY}-xyz.a.run.app`);
    expect(gateway).toContain(`CAELO_ADMIN_URL=https://${ADMIN}-xyz.a.run.app`);
    expect(gateway).toContain(`CAELO_MCP_PUBLIC_URL=https://${GATEWAY}-xyz.a.run.app`);
    expect(gateway).toContain(
      "--update-secrets=/secrets/operator-oauth-client/client.json=caelo-production-operator-oauth-client:latest",
    );
    expect(gateway).toContain("--timeout=3600");
    expect(admin).not.toContain("--timeout");
    // No extra revision: everything rides the image rolls.
    expect(calls.filter((c) => /^run services update /.test(c))).toHaveLength(2);
  });

  it("#806 — on gcp, routes the discovery paths and adds the Cloud Armor rule before the roll", async () => {
    const events: string[] = [];
    const urlMap = {
      name: "caelo-production-url-map-1",
      hostRules: [{ hosts: ["acme.com"], pathMatcher: "public" }],
      pathMatchers: [{ name: "public", pathRules: [{ paths: ["/api/*"], service: "gw" }] }],
    };
    const puts: string[] = [];
    const { deps, lines } = upgradeDeps(events, {
      overrides: [
        [/^compute url-maps list/, ok(JSON.stringify([urlMap]))],
        [/^compute security-policies list/, ok("caelo-production-waf-1\n")],
        [/^compute security-policies describe/, ok(JSON.stringify({ rules: [] }))],
      ],
    });
    const recordingHttp: HttpFetch = async (url, init) => {
      if (init.method === "PUT" && url.includes("/urlMaps/"))
        puts.push(`${url} ${init.body ?? ""}`);
      return http(url, init);
    };
    expect(await upgradeGcpInstall(GCP_TARGET, { ...deps, http: recordingHttp })).toBe(true);
    expect(events).toContainEqual(
      expect.stringMatching(
        /^gcloud compute security-policies rules create 900 --security-policy=caelo-production-waf-1 /,
      ),
    );
    expect(puts).toHaveLength(1);
    expect(puts[0]).toContain("/global/urlMaps/caelo-production-url-map-1");
    expect(puts[0]).toContain("/.well-known/oauth-authorization-server/*");
    expect(lines).toContain("done: Remote-MCP load-balancer rules ready");
    expect(indexOf(events, /security-policies rules create/)).toBeLessThan(
      indexOf(events, /^migrate /),
    );
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
    expect(calls.filter((c) => CONVERGE_WRITE.test(c) || APP_ROLL_WRITE.test(c))).toEqual([]);
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
    expect(events.filter((e) => e.includes("--to-revisions"))).toHaveLength(2);
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
      `info:   applied: ingress internal-and-cloud-load-balancing → all on ${GATEWAY} (the gcp-firebase stack's gateway ingress (#650); the health check, the staging domain and remote MCP reach its run.app URL)`,
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
    expect(calls.filter((c) => /^run services update /.test(c))).toHaveLength(2);
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
