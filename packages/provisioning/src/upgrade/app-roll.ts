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
import { adminMediaVolume } from "../stack-contract.js";
import {
  type DeployedService,
  type EnvChange,
  type LiveEnvValue,
  type LiveVolumes,
  liveContainerEnv,
  liveContainerMemory,
  liveVolumes,
  planAdminMemory,
  planContractEnv,
  planMediaVolume,
  rollService,
  serviceRollArgs,
} from "../stack-converge.js";
import { restoreCommand, type SqlBackup } from "./backup.js";
import {
  describeServiceJson,
  findCurrentRevision,
  findServiceUrl,
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
}

/** A service plan plus the changes its roll applies. */
export interface RollPlan extends ServicePlan {
  readonly envFlags: readonly string[];
  readonly envChanges: readonly EnvChange[];
  /** #553 — e.g. `--memory=2Gi` when the admin runs below the stack default. */
  readonly resourceFlags: readonly string[];
  /** The admin's media bucket volume when it is (partly) missing; empty otherwise. */
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
): Promise<PlanResult> {
  const services: ServicePlan[] = [];
  for (const slug of ROLL_ORDER) {
    const prefix = `caelo-${install.env}-${slug}`;
    const serviceName = await resolveGcpResourceName(
      run,
      "run-service",
      prefix,
      install.projectId,
      install.region,
    );
    if (!serviceName)
      return { ok: false, error: `Could not find the ${prefix}* Cloud Run service` };
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
    });
  }
  const env = planEnv(install, services, []);
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
  const warnings: string[] = [];
  const rolls = services.map((s): RollPlan => {
    // #553 — the admin runs the Lighthouse quality audit; raise it to the
    // stack's memory default (never lowered; an unparsable value is kept).
    const memory = s.slug === "admin" ? planAdminMemory(s.liveMemory) : null;
    if (memory && !memory.ok) warnings.push(`admin memory left as is: ${memory.error}`);
    return {
      ...s,
      envFlags: env.services[s.slug].flags,
      envChanges: env.services[s.slug].changes,
      resourceFlags: memory?.ok ? memory.flags : [],
      volumeFlags: s.slug === "admin" ? media.flags : [],
      volumeChanges: s.slug === "admin" ? media.changes : [],
    };
  });
  return { ok: true, plan: { install, services: rolls, warnings } };
}

function planEnv(
  install: AppRollInstall,
  services: readonly ServicePlan[],
  leaveUntouched: readonly string[],
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
    { leaveUntouched },
  );
}

/**
 * The plan with `names` left exactly as the services have them — for env
 * vars that point at something a converge step could not set up.
 */
export function leavingEnvUntouched(plan: AppRollPlan, names: readonly string[]): AppRollPlan {
  if (names.length === 0) return plan;
  const env = planEnv(plan.install, plan.services, names);
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
    for (const c of s.volumeChanges) reporter.info(`${s.slug} media: ${c}`);
    for (const f of s.resourceFlags) {
      reporter.info(`${s.slug} resources: ${s.liveMemory ?? "(default)"} → ${f}`);
    }
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
    { readonly ok: true; readonly leaveUntouched: readonly string[] } | { readonly ok: false }
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
  const fail = (phase: AppRollPhase, migrated: boolean): AppRollResult => ({
    ok: false,
    phase,
    migrated,
  });

  // A probe that cannot reach the install now would only fail after the
  // migrations, and roll a healthy release back.
  if (deps.health) {
    const s = r.step("Checking the health check can reach admin + gateway...");
    const base = await deps.health.baseline();
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
    plan = leavingEnvUntouched(plan, converged.leaveUntouched);
  }

  const rolled: RollPlan[] = [];
  const rollBack = async (alsoCurrent?: RollPlan): Promise<void> => {
    const services = alsoCurrent ? [...rolled, alsoCurrent] : rolled;
    if (services.length === 0) return;
    r.warn(`Rolling back ${services.length} service(s) to the revisions that served before...`);
    for (const p of [...services].reverse()) {
      const ok = await pinTraffic(
        run,
        install.projectId,
        install.region,
        p.serviceName,
        p.priorRevision,
      );
      if (ok) r.info(`  ${p.slug} traffic restored to ${p.priorRevision}`);
      else r.error(`  ${p.slug} rollback FAILED — pin ${p.priorRevision} by hand`);
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

  if (deps.health) {
    const s = r.step("Deep health check (database, migrations, version)...");
    const deep = await deps.health.deep({ version: input.targetVersion });
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
