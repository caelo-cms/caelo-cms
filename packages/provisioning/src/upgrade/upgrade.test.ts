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
import type { HealthOutcome, HealthProbe } from "./health.js";
import type { UpgradeReporter } from "./reporter.js";
import { type GcpUpgradeDeps, type GcpUpgradeTarget, upgradeGcpInstall } from "./upgrade.js";

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

/** A described service, as `gcloud run services describe --format=json` returns it. */
const serviceJson = (image: string, env: unknown[]) =>
  JSON.stringify({
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

const ADMIN_JSON = serviceJson("registry/admin@sha256:old", [
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
};

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
  /add-iam-policy-binding|remove-iam-policy-binding|set-iam-policy|service-accounts create|secrets create|secrets versions add|services enable|roles create|firewall-rules delete|users assign-roles/;
/** Calls that move a service or run migrations — app-roll-only. */
const APP_ROLL_WRITE =
  /^run services update |^run services update-traffic|jobs execute caelo-migrate/;
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
    expect(recorded.digests).toEqual([]);
    expect(recorded.contract).toEqual([]);
    const restore = `gcloud sql backups restore ${BACKUP_ID} --restore-instance=${SQL} --project=acme`;
    expect(lines.some((l) => l.startsWith("warn:") && l.includes(restore))).toBe(true);
    // The rollback is the end: retired bindings stay until a healthy roll.
    expect(calls.some((c) => c.includes("remove-iam-policy-binding"))).toBe(false);
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
};

async function plannedRoll(run: GcloudRunner): Promise<AppRollPlan> {
  const planned = await planAppRoll(INSTALL, IMAGES, run);
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
    expect(result).toEqual({ ok: false, phase: "roll", migrated: true });
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
    expect(result).toEqual({ ok: false, phase: "migrations", migrated: true });
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
      { projectId: "acme", env: "production" },
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
    const r = await takeSqlBackup(run, { projectId: "acme", env: "production" }, "backup");
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.error).toContain("gcloud sql backups list --instance=caelo-production-pg-abc");
  });

  it("fails when the install has no Cloud SQL instance", async () => {
    const { run } = fakeInstall([], [[/^sql instances list/, ok("")]]);
    const r = await takeSqlBackup(run, { projectId: "acme", env: "production" }, "backup");
    expect(r).toEqual({
      ok: false,
      error:
        "no caelo-production-pg* Cloud SQL instance in project acme (or listing it was denied)",
    });
  });
});
