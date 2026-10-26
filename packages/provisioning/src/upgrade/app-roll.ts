// SPDX-License-Identifier: MPL-2.0

/**
 * The app-roll half of an upgrade (epic #696): migrations with the new admin
 * image, then admin and gateway onto their new images with the env contract
 * riding the same revision, traffic onto the new revisions, a deep health
 * check, and — on any failure — traffic back onto the revisions that served
 * before.
 *
 * It never changes IAM, never creates a service account or secret and never
 * touches other cloud resources: everything here works under an identity
 * that may only deploy Cloud Run revisions, run the migration job and take a
 * Cloud SQL backup. That is the identity the in-cloud upgrader job runs as.
 * Whatever needs more lives in converge.ts; `cms-provision upgrade` runs
 * both, and the upgrader job refuses to run while the install needs a
 * converge (`needsConverge`).
 *
 * Converge steps that must sit between app-roll steps — a database role that
 * a migration creates gets its password after migrations and before the
 * gateway rolls — come in through {@link AppRollHooks}. The upgrader job
 * passes none.
 *
 * All gcloud calls go through the injected runner, all output through the
 * injected reporter, so the whole sequence runs against a fake in tests.
 */

import type { GcloudRunner, Sleep } from "../gcloud-retry.js";
import { gatewayServiceAccountEmail, runServiceAccountEmail } from "../gcp-names.js";
import type { ImageDigests } from "../install-state.js";
import {
  adminMediaVolume,
  type CloudRunEnvVar,
  GATEWAY_TIMEOUT_SECONDS,
  RETIRED_SECRET_FILES,
  SERVICE_CPU_IDLE,
  SERVICE_SECRET_FILES,
} from "../stack-contract.js";
import {
  type DeployedService,
  type EnvChange,
  findVolumesWithMissingSecrets,
  type LiveEnvValue,
  type LiveVolumes,
  liveContainerEnv,
  liveContainerMemory,
  liveCpuIdle,
  liveTimeoutSeconds,
  liveVolumes,
  planAdminMemory,
  planContractEnv,
  planCpuIdle,
  planMediaVolume,
  planRequestTimeout,
  planSecretFiles,
  rollService,
  serviceRollArgs,
} from "../stack-converge.js";
import { describeAuditJobImage, setAuditJobImage } from "./audit-job-roll.js";
import { restoreCommand, type SqlBackup } from "./backup.js";
import {
  describeServiceJson,
  findCurrentRevision,
  findServiceUrl,
  type GcloudCredentials,
  lookupFailure,
  pinTraffic,
  resolveGcpResourceName,
} from "./gcp-lookup.js";
import type { HealthProbe } from "./health.js";
import type { UpgradeReporter } from "./reporter.js";

export type RollSlug = "admin" | "gateway";

/** The roll order: the gateway follows the admin, never the other way round. */
export const ROLL_ORDER: readonly RollSlug[] = ["admin", "gateway"];

/** The install an app-roll acts on. */
export interface AppRollInstall {
  readonly provider: "gcp" | "gcp-firebase";
  readonly projectId: string;
  readonly region: string;
  /** Pulumi stack name (`production`). */
  readonly env: string;
  readonly domain: string;
  /** The protected staging host the admin is told about (#650). */
  readonly stagingHost: string;
  /** Whose gcloud credentials the lookups run with; names the fix for an auth failure. */
  readonly credentials: GcloudCredentials;
}

/** The release image one service rolls to. */
export interface ReleaseImage {
  /** Fully qualified, digest-pinned reference (`…/admin@sha256:…`). */
  readonly imageRef: string;
  readonly digest: string;
}

/** A service as it runs now, plus the image it rolls to. */
export interface ServicePlan {
  readonly slug: RollSlug;
  readonly serviceName: string;
  readonly imageRef: string;
  readonly digest: string;
  readonly priorRevision: string;
  readonly liveEnv: ReadonlyMap<string, LiveEnvValue>;
  /** Container memory limit now (null = Cloud Run's default). */
  readonly liveMemory: string | null;
  readonly liveVolumes: LiveVolumes;
  /** Request timeout now, in seconds (null = Cloud Run's default). */
  readonly liveTimeout: number | null;
  /** Whether the service gets CPU only during requests now. */
  readonly liveCpuIdle: boolean;
}

/** A service plan plus the changes its roll applies. */
export interface RollPlan extends ServicePlan {
  readonly envFlags: readonly string[];
  readonly envChanges: readonly EnvChange[];
  /**
   * #553 — e.g. `--memory=2Gi` when the admin runs below the stack default;
   * #806 — `--timeout=3600` when the gateway runs below its contract timeout;
   * `--cpu-throttling` when the contract wants request-based CPU.
   */
  readonly resourceFlags: readonly string[];
  readonly resourceChanges: readonly string[];
  /**
   * The admin's media bucket volume when it is (partly) missing, the
   * service's secret files (#806, the gateway's OAuth client) when not
   * mounted; empty otherwise.
   */
  readonly volumeFlags: readonly string[];
  readonly volumeChanges: readonly string[];
}

/** Everything an app-roll will do, computed read-only before anything changes. */
export interface AppRollPlan {
  readonly install: AppRollInstall;
  /** In {@link ROLL_ORDER}. */
  readonly services: readonly RollPlan[];
  /** Notes for the operator (e.g. a memory limit left as is). */
  readonly warnings: readonly string[];
}

export type PlanResult =
  | { readonly ok: true; readonly plan: AppRollPlan }
  | { readonly ok: false; readonly error: string };

/**
 * Read both services and plan their rolls: prior revisions (the rollback
 * targets), env-contract changes, the admin's memory and media volume. Makes
 * no change; fails when anything a roll needs is missing.
 */
export async function planAppRoll(
  install: AppRollInstall,
  images: Readonly<Record<RollSlug, ReleaseImage>>,
  run: GcloudRunner,
  checks: {
    /**
     * #954 — check that every secret volume's secret still exists. The
     * operator / converge identity can read secret metadata; the upgrader
     * job's narrow identity holds no Secret Manager permission at all
     * (upgrader-setup.ts), so it passes false.
     */
    readonly secretVolumes: boolean;
  },
): Promise<PlanResult> {
  const services: ServicePlan[] = [];
  for (const slug of ROLL_ORDER) {
    const prefix = `caelo-${install.env}-${slug}`;
    const lookup = await resolveGcpResourceName(
      run,
      "run-service",
      prefix,
      install.projectId,
      install.region,
    );
    if (lookup.status !== "found") {
      return {
        ok: false,
        error: lookupFailure(lookup, `${prefix}* Cloud Run service`, install.credentials),
      };
    }
    const serviceName = lookup.name;
    const priorRevision = await findCurrentRevision(
      run,
      install.projectId,
      install.region,
      serviceName,
    );
    if (!priorRevision) {
      return {
        ok: false,
        error: `Could not capture the current ${slug} revision — refusing to roll`,
      };
    }
    const json = await describeServiceJson(run, install.projectId, install.region, serviceName);
    if (!json) {
      return {
        ok: false,
        error: `Could not read the ${slug} service's configuration — refusing to roll`,
      };
    }
    services.push({
      slug,
      serviceName,
      ...images[slug],
      priorRevision,
      liveEnv: liveContainerEnv(json),
      liveMemory: liveContainerMemory(json),
      liveVolumes: liveVolumes(json),
      liveTimeout: liveTimeoutSeconds(json),
      liveCpuIdle: liveCpuIdle(json),
    });
  }
  const env = planEnv(install, services, {});
  if (!env.ok)
    return { ok: false, error: `the install's env contract can't be applied: ${env.error}` };
  // Without the media volume every upload is lost on the next revision or
  // scale-to-zero, so a volume the roll cannot add fails the plan.
  const admin = services.find((s) => s.slug === "admin") as ServicePlan;
  const media = planMediaVolume(
    admin.liveVolumes,
    adminMediaVolume(install.projectId, install.env),
  );
  if (!media.ok)
    return { ok: false, error: `the admin's media volume can't be set up: ${media.error}` };
  // #806/#914 — each service's secret files (the gateway's Google sign-in
  // client). A file the roll cannot mount fails the plan: the new gateway
  // reads its path from the env contract.
  const secretFiles = {} as Record<RollSlug, { flags: string[]; changes: string[] }>;
  for (const s of services) {
    const files = planSecretFiles(
      s.liveVolumes,
      SERVICE_SECRET_FILES[s.slug],
      install.env,
      RETIRED_SECRET_FILES[s.slug],
    );
    if (!files.ok) {
      return { ok: false, error: `the ${s.slug}'s secret files can't be mounted: ${files.error}` };
    }
    secretFiles[s.slug] = files;
  }
  // #954 — a volume pointing at a deleted secret makes Cloud Run refuse
  // every new revision: name it with its fix now, before any roll starts.
  const orphaned: string[] = [];
  for (const s of checks.secretVolumes ? services : []) {
    const removing = secretFiles[s.slug].flags
      .filter((f) => f.startsWith("--remove-volume="))
      .map((f) => f.slice("--remove-volume=".length));
    orphaned.push(
      ...(await findVolumesWithMissingSecrets(
        s.liveVolumes,
        { serviceName: s.serviceName, projectId: install.projectId, region: install.region },
        removing,
        run,
      )),
    );
  }
  if (orphaned.length > 0) {
    return { ok: false, error: `a service can't take a new revision: ${orphaned.join(" ")}` };
  }
  const warnings: string[] = [];
  const rolls = services.map((s): RollPlan => {
    // #553 — the admin runs the Lighthouse quality audit; raise it to the
    // stack's memory default (never lowered; an unparsable value is kept).
    const memory = s.slug === "admin" ? planAdminMemory(s.liveMemory) : null;
    if (memory && !memory.ok) warnings.push(`admin memory left as is: ${memory.error}`);
    // #806 — the gateway streams remote-MCP chat turns (stack-contract.ts
    // GATEWAY_TIMEOUT_SECONDS). The admin's timeout is the stacks' alone.
    const timeout =
      s.slug === "gateway" ? planRequestTimeout(s.liveTimeout, GATEWAY_TIMEOUT_SECONDS) : null;
    const memoryFlags = memory?.ok ? memory.flags : [];
    const timeoutFlags = timeout?.ok ? timeout.flags : [];
    const cpu = planCpuIdle(s.liveCpuIdle, SERVICE_CPU_IDLE[s.slug]);
    const cpuFlags = cpu.ok ? cpu.flags : [];
    return {
      ...s,
      envFlags: env.services[s.slug].flags,
      envChanges: env.services[s.slug].changes,
      resourceFlags: [...memoryFlags, ...timeoutFlags, ...cpuFlags],
      resourceChanges: [
        ...memoryFlags.map((f) => `${s.liveMemory ?? "(default)"} → ${f}`),
        ...(timeout?.ok ? timeout.changes : []),
        ...(cpu.ok ? cpu.changes : []),
      ],
      volumeFlags: [...(s.slug === "admin" ? media.flags : []), ...secretFiles[s.slug].flags],
      volumeChanges: [...(s.slug === "admin" ? media.changes : []), ...secretFiles[s.slug].changes],
    };
  });
  return { ok: true, plan: { install, services: rolls, warnings } };
}

/** Env the converge half adds to, or keeps out of, the rolls ({@link AppRollHooks.afterMigrations}). */
export interface EnvAdjustments {
  /** Contract vars to leave exactly as the services have them. */
  readonly leaveUntouched?: readonly string[];
  /**
   * Vars outside the env contract the rolls set too — #806's remote-MCP
   * identity env, which only the converge (operator identity) can resolve.
   */
  readonly extraEnv?: Readonly<Partial<Record<RollSlug, readonly CloudRunEnvVar[]>>>;
}

function planEnv(
  install: AppRollInstall,
  services: readonly ServicePlan[],
  adjust: EnvAdjustments,
) {
  const deployed = Object.fromEntries(
    services.map((s) => [s.slug, { serviceName: s.serviceName, liveEnv: s.liveEnv }]),
  ) as Record<RollSlug, DeployedService>;
  return planContractEnv(
    {
      provider: install.provider,
      projectId: install.projectId,
      env: install.env,
      domain: install.domain,
      region: install.region,
      stagingHost: install.stagingHost,
    },
    deployed,
    {
      leaveUntouched: adjust.leaveUntouched ?? [],
      ...(adjust.extraEnv ? { extraEnv: adjust.extraEnv } : {}),
    },
  );
}

/**
 * The plan with the converge's adjustments: vars left exactly as the
 * services have them (they point at something a converge step could not set
 * up) and vars outside the contract the rolls set too.
 */
export function adjustingEnv(plan: AppRollPlan, adjust: EnvAdjustments): AppRollPlan {
  const extra = Object.values(adjust.extraEnv ?? {}).some((v) => (v?.length ?? 0) > 0);
  if ((adjust.leaveUntouched?.length ?? 0) === 0 && !extra) return plan;
  const env = planEnv(plan.install, plan.services, adjust);
  if (!env.ok) return plan;
  return {
    ...plan,
    services: plan.services.map((s) => ({
      ...s,
      envFlags: env.services[s.slug].flags,
      envChanges: env.services[s.slug].changes,
    })),
  };
}

/** Print what the plan will change, one line per change. */
export function reportPlan(plan: AppRollPlan, reporter: UpgradeReporter): void {
  for (const w of plan.warnings) reporter.warn(w);
  for (const s of plan.services) {
    for (const c of s.volumeChanges) reporter.info(`${s.slug} volumes: ${c}`);
    for (const c of s.resourceChanges) reporter.info(`${s.slug} resources: ${c}`);
    for (const c of s.envChanges) {
      reporter.info(
        `${s.slug} env ${c.name}: ${c.from === undefined ? "(unset)" : c.from} → ${c.to === undefined ? "(removed)" : c.to}`,
      );
    }
  }
}

/** Converge steps that must sit between app-roll steps (none for the upgrader job). */
export interface AppRollHooks {
  /**
   * After migrations, before any service rolls. Returns the contract env
   * vars the rolls must leave untouched because what they point at could
   * not be set up; `ok: false` aborts the upgrade (nothing rolled yet).
   */
  afterMigrations?(): Promise<
    | ({ readonly ok: true; readonly leaveUntouched: readonly string[] } & Pick<
        EnvAdjustments,
        "extraEnv"
      >)
    | { readonly ok: false }
  >;
  /** Right before `slug` rolls; `ok: false` aborts and rolls back what rolled. */
  beforeRoll?(
    slug: RollSlug,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }>;
  /** After `slug` went back to its prior revision (or its roll failed). */
  afterRollback?(slug: RollSlug): Promise<void>;
}

export interface AppRollDeps {
  readonly run: GcloudRunner;
  readonly sleep?: Sleep;
  readonly reporter: UpgradeReporter;
  /** Runs both migration targets with `imageRef` (the NEW admin image). */
  readonly migrate: (
    imageRef: string,
  ) => Promise<{ readonly ok: boolean; readonly error?: string }>;
  /** The deep health check, or null when the operator explicitly skipped it. */
  readonly health: HealthProbe | null;
  /** Persist the digests now serving (install.json, stack config, …). */
  readonly recordDigests: (digests: ImageDigests) => Promise<void>;
}

export interface AppRollInput {
  readonly plan: AppRollPlan;
  /**
   * The backup taken before this roll. Required: migrations never run
   * without a backup to go back to.
   */
  readonly backup: SqlBackup;
  /** The release version rolled to, when known (`0.11.0`; null for a channel tag). */
  readonly targetVersion: string | null;
  /**
   * Whether the release's migrations are contract-type (destructive for the
   * previous release; from the signed release manifest). null = unknown.
   */
  readonly migrationsContract: boolean | null;
}

export type AppRollPhase = "health-baseline" | "migrations" | "converge" | "roll" | "health";

export type AppRollResult =
  | { readonly ok: true; readonly digests: ImageDigests }
  | {
      readonly ok: false;
      readonly phase: AppRollPhase;
      /** Whether migrations ran before the failure (the backup matters then). */
      readonly migrated: boolean;
      /**
       * Whether services had rolled and EVERY one of them was pinned back to
       * the revision that served before — i.e. the previous release serves
       * again. False when nothing had rolled, or when a pin failed (then a
       * person must pin it; the reporter named which).
       */
      readonly rolledBack: boolean;
    };

/** Run the app-roll. See the file comment for the sequence. */
export async function executeAppRoll(
  input: AppRollInput,
  hooks: AppRollHooks,
  deps: AppRollDeps,
): Promise<AppRollResult> {
  const { reporter: r, run } = deps;
  const { install } = input.plan;
  let plan = input.plan;
  /** Set by {@link rollBack}: null until one ran with services to restore. */
  let rollbackOk: boolean | null = null;
  const fail = (phase: AppRollPhase, migrated: boolean): AppRollResult => ({
    ok: false,
    phase,
    migrated,
    rolledBack: rollbackOk === true,
  });

  // A probe that cannot reach the install now would only fail after the
  // migrations, and roll a healthy release back.
  if (deps.health) {
    const s = r.step("Checking the health check can reach admin + gateway...");
    const base = await deps.health
      .baseline((reason) => s.progress(reason))
      .catch((e: unknown) => ({
        ok: false as const,
        error: e instanceof Error ? e.message : String(e),
      }));
    if (!base.ok) {
      s.failed(`Health check can't reach the install: ${base.error}`);
      r.warn(
        "No migrations ran and no traffic moved. Fix the access problem, or re-run with --skip-health-check to roll with Cloud Run's readiness check only.",
      );
      return fail("health-baseline", false);
    }
    s.done(`Health check reaches the install (${base.detail})`);
  } else {
    r.warn("--skip-health-check set — the new revisions get Cloud Run's readiness check only.");
  }

  // Migrations BEFORE any traffic moves, with the NEW admin image: the old
  // image does not carry the release's migration files (v0.9.2).
  const admin = plan.services.find((s) => s.slug === "admin") as RollPlan;
  const sMig = r.step("Applying DB migrations (idempotent)...");
  const mig = await deps.migrate(admin.imageRef);
  if (!mig.ok) {
    sMig.failed(`Migrations failed (${mig.error ?? "unknown"}). Aborting upgrade.`);
    r.warn(
      `No traffic was shifted. Inspect the Cloud Run Job logs:\n  gcloud logging read 'resource.type=cloud_run_job AND resource.labels.job_name=~"caelo-migrate-.*"' --project=${install.projectId} --limit=50\n${restoreHint(input, "if a migration left the schema half-applied")}`,
    );
    return fail("migrations", true);
  }
  sMig.done("Migrations applied");

  if (hooks.afterMigrations) {
    const converged = await hooks.afterMigrations();
    if (!converged.ok) return fail("converge", true);
    plan = adjustingEnv(plan, {
      leaveUntouched: converged.leaveUntouched,
      ...(converged.extraEnv ? { extraEnv: converged.extraEnv } : {}),
    });
  }

  const rolled: RollPlan[] = [];
  /** The audit job's image before this roll moved it (#875); null = not moved. */
  let auditJobPriorImage: string | null = null;
  const rollBack = async (alsoCurrent?: RollPlan): Promise<void> => {
    if (auditJobPriorImage) {
      const back = await setAuditJobImage(run, install, auditJobPriorImage);
      if (back.ok) r.info(`  audit job image restored to ${auditJobPriorImage.slice(-19)}`);
      else
        r.error(
          `  audit job rollback FAILED (${back.error}) — set its image to ${auditJobPriorImage} by hand`,
        );
    }
    const services = alsoCurrent ? [...rolled, alsoCurrent] : rolled;
    if (services.length === 0) return;
    r.warn(`Rolling back ${services.length} service(s) to the revisions that served before...`);
    rollbackOk = true;
    for (const p of [...services].reverse()) {
      const ok = await pinTraffic(
        run,
        install.projectId,
        install.region,
        p.serviceName,
        p.priorRevision,
      );
      if (ok) r.info(`  ${p.slug} traffic restored to ${p.priorRevision}`);
      else {
        rollbackOk = false;
        r.error(`  ${p.slug} rollback FAILED — pin ${p.priorRevision} by hand`);
      }
      await hooks.afterRollback?.(p.slug);
    }
  };

  for (const p of plan.services) {
    const s = r.step(`Rolling ${p.slug} → ${p.digest.slice(0, 19)}...`);
    const before = (await hooks.beforeRoll?.(p.slug)) ?? { ok: true as const };
    if (!before.ok) {
      s.failed(before.error);
      await rollBack();
      return fail("roll", true);
    }
    const upd = await rollService(
      serviceRollArgs({
        serviceName: p.serviceName,
        region: install.region,
        projectId: install.projectId,
        imageRef: p.imageRef,
        serviceAccount:
          p.slug === "admin"
            ? runServiceAccountEmail(install.projectId, install.env)
            : gatewayServiceAccountEmail(install.projectId, install.env),
        envFlags: p.envFlags,
        resourceFlags: p.resourceFlags,
        volumeFlags: p.volumeFlags,
      }),
      { run, ...(deps.sleep ? { sleep: deps.sleep } : {}) },
    );
    if (!upd.ok) {
      s.failed(`Failed: ${upd.stderr.trim()}`);
      // The failed update created no serving revision; only undo what the
      // hook changed for it, then the services that rolled before.
      await hooks.afterRollback?.(p.slug);
      await rollBack();
      return fail("roll", true);
    }
    // `update --image` only moves traffic when the service has no explicit
    // traffic config — but a rollback pins traffic to the prior revision,
    // and that pin survives later updates. Moving traffic to latest on
    // every roll is idempotent and un-pins services an earlier failed
    // upgrade left pinned.
    const flip = await run([
      "run",
      "services",
      "update-traffic",
      p.serviceName,
      "--region",
      install.region,
      "--project",
      install.projectId,
      "--to-latest",
      "--quiet",
    ]);
    if (!flip.ok) {
      s.failed(`Traffic flip to latest failed: ${flip.stderr.trim()}`);
      await rollBack(p);
      return fail("roll", true);
    }
    if (!(await findServiceUrl(run, install.projectId, install.region, p.serviceName))) {
      s.failed(`Could not resolve the service URL for ${p.slug} — rolling back`);
      await rollBack(p);
      return fail("roll", true);
    }
    s.done(`${p.slug} rolled to ${p.digest.slice(0, 19)}...`);
    rolled.push(p);
  }

  // #875 — the audit job runs the admin's image; it follows the admin. A
  // failure here does not undo the release: audits then fail loudly with
  // the version mismatch and the fix, until the next upgrade moves it.
  const sAudit = r.step("Moving the quality-audit job onto the admin's image...");
  const described = await describeAuditJobImage(run, install);
  const auditPrior = described.ok ? described.image : null;
  if (!described.ok) {
    sAudit.warned(
      `Could not read the quality-audit job (${described.error}); Stage audits fail until the next upgrade moves it.`,
    );
  } else if (!auditPrior) {
    sAudit.warned(
      "The install has no quality-audit job yet; Stage audits fail until `cms-provision upgrade` sets it up.",
    );
  } else if (auditPrior === admin.imageRef) {
    sAudit.done("Quality-audit job already on the admin's image");
  } else {
    const moved = await setAuditJobImage(run, install, admin.imageRef);
    if (moved.ok) {
      auditJobPriorImage = auditPrior;
      sAudit.done(`Quality-audit job on ${admin.digest.slice(0, 19)}...`);
    } else {
      sAudit.warned(
        `Quality-audit job not moved (${moved.error}); Stage audits fail until the next upgrade moves it.`,
      );
    }
  }

  if (deps.health) {
    const s = r.step("Deep health check (database, migrations, version)...");
    // A probe that throws is a failed check: roll back, never leave the
    // new revisions serving unverified.
    const deep = await deps.health.deep({ version: input.targetVersion }).catch((e: unknown) => ({
      ok: false as const,
      error: e instanceof Error ? e.message : String(e),
    }));
    if (!deep.ok) {
      s.failed(`Deep health check failed: ${deep.error}`);
      await rollBack();
      r.warn(restoreHint(input, "if the previous release now fails against the migrated schema"));
      return fail("health", true);
    }
    s.done(`Healthy: ${deep.detail}`);
  }

  const digests: ImageDigests = {
    admin: (plan.services.find((s) => s.slug === "admin") as RollPlan).digest,
    gateway: (plan.services.find((s) => s.slug === "gateway") as RollPlan).digest,
  };
  await deps.recordDigests(digests);
  return { ok: true, digests };
}

/**
 * The restore hint after migrations ran and the roll failed. Expand-only
 * migrations leave a schema the previous release still runs on, so restoring
 * is only advised outright for contract-type migrations.
 */
function restoreHint(input: AppRollInput, when: string): string {
  const cmd = restoreCommand(input.backup);
  if (input.migrationsContract === true) {
    return `This release's migrations are contract-type: the previous release may not work against the migrated schema. Restore the pre-upgrade backup ${input.backup.backupId} (overwrites all data written since):\n  ${cmd}`;
  }
  return `Pre-upgrade backup: ${input.backup.backupId}. Restore it only ${when} (overwrites all data written since):\n  ${cmd}`;
}
