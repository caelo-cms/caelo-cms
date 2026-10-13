// SPDX-License-Identifier: MPL-2.0

/**
 * #696 Phase 4 — `cms-provision upgrade` for a self-hosted Compose install.
 *
 * Order, and why:
 *   1. resolve the target release to digests + cosign-verify them — nothing
 *      on the host changes until the images are known-good;
 *   2. back up both databases (pg_dump, hard-fail) — the last moment the
 *      schema is guaranteed to match the running images;
 *   3. write the new digests into the Compose file, `docker compose pull`;
 *   4. run the migrations from the NEW admin image (`docker compose run`,
 *      the same `migrate.ts` entrypoint the GCP migrate job runs) while the
 *      old containers keep serving — migrations are expand-only, so the
 *      running release works on the new schema;
 *   5. recreate the admin, health-check it (`/_caelo/health`, which proves
 *      the DB pool and roles); then the gateway (`/healthz`);
 *   6. record the release in `.caelo/release.json`.
 * Any failure after step 3 puts the previous Compose file back; once a
 * container was recreated the previous images are started again and
 * health-checked (rollback). The database is never restored automatically:
 * the expand-only migrations keep the previous release working, and the
 * backup path is printed for the case they do not.
 *
 * Idempotent: a target equal to the recorded release is a no-op; a run that
 * stopped half-way is simply repeated (pull, migrate and `up` converge).
 *
 * pgBackRest is NOT used: the Compose file's sidecar has no access to the
 * Postgres data volume and no stanza is ever created, so `pg_dump` (from the
 * Postgres container itself) is the backup that actually works here.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReleaseImages } from "./compose.js";
import { fetchLatestReleaseTag, RELEASE_SERVICES, releaseTag } from "./release-images.js";
import {
  type HostRunner,
  readRelease,
  recordRelease,
  recordRollback,
  releaseImages,
  resolveVerifiedRelease,
} from "./self-hosted-release.js";

/** The Compose service names of the two Caelo services. */
const COMPOSE_SERVICE = { admin: "caelo-admin", gateway: "caelo-gateway" } as const;

/** Progress output; the CLI wires it to the terminal, tests to an array. */
export interface UpgradeLog {
  step(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface SelfHostedUpgradeDeps {
  /** The install's `.caelo/` directory (docker-compose.yml, release.json, backups/). */
  readonly caeloDir: string;
  readonly runner: HostRunner;
  /** Renders the Compose file for `images` from the install's config (secrets included). */
  readonly renderCompose: (images: ReleaseImages) => string;
  readonly log: UpgradeLog;
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
  /** Health probe attempts per service and the pause between them. */
  readonly healthAttempts?: number;
  readonly healthIntervalMs?: number;
}

export interface SelfHostedUpgradeOpts {
  readonly version?: string;
  readonly channel?: "stable" | "rc" | "beta";
  readonly skipVerify?: boolean;
}

export type SelfHostedUpgradeResult =
  | { readonly ok: true; readonly status: "upgraded" | "already-current"; readonly version: string }
  | {
      readonly ok: false;
      readonly stage: UpgradeStage;
      readonly error: string;
      /** Whether the previous release is running again (true when nothing had changed yet). */
      readonly previousRunning: boolean;
    };

type UpgradeStage =
  | "target"
  | "verify"
  | "converge"
  | "backup"
  | "pull"
  | "migrate"
  | "roll-admin"
  | "roll-gateway";

export function composePath(caeloDir: string): string {
  return join(caeloDir, "docker-compose.yml");
}

/** `docker compose -f <file>` — every Compose call targets the install's file explicitly. */
function compose(caeloDir: string, ...args: string[]): string[] {
  return ["docker", "compose", "-f", composePath(caeloDir), ...args];
}

/**
 * Upgrade a self-hosted install to `opts.version` (or the newest stable
 * release). Never throws for an expected failure; the result says which
 * stage failed and whether the previous release is serving again.
 */
export async function upgradeSelfHosted(
  opts: SelfHostedUpgradeOpts,
  deps: SelfHostedUpgradeDeps,
): Promise<SelfHostedUpgradeResult> {
  const { caeloDir, runner, log } = deps;
  const now = deps.now ?? (() => new Date());
  const current = readRelease(caeloDir);
  const file = composePath(caeloDir);
  if (!existsSync(file)) {
    return fail("target", `${file} does not exist — run \`cms-provision init\` first.`, true);
  }
  // The file to restore on failure: the recorded release re-rendered (so a
  // run that stopped after writing new digests cannot "restore" those), or —
  // for an install from before #696 with no record — the file as it is.
  const previousCompose = current
    ? deps.renderCompose(releaseImages(current))
    : readFileSync(file, "utf8");

  // 1. Target release → verified digests.
  const target = await targetVersion(opts, deps.fetchImpl);
  if (!target.ok) return fail("target", target.error, true);
  log.step(
    `Upgrading ${current ? `${current.version} → ` : "(repo-mounted install) → "}${target.version}`,
  );
  const resolved = await resolveVerifiedRelease(target.tag, {
    runner,
    ...(opts.skipVerify ? { skipVerify: true } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    onProgress: (m) => log.info(m),
  });
  if (!resolved.ok) return fail("verify", resolved.error, true);
  if (opts.skipVerify) log.warn("--skip-verify set — image signatures NOT verified.");
  const images = resolved.images;
  if (
    current &&
    current.images.admin === images.admin &&
    current.images.gateway === images.gateway &&
    readFileSync(file, "utf8") === previousCompose
  ) {
    // Recorded, and the Compose file agrees. `up` converges containers a
    // stopped run or a failed rollback may have left on other images (a
    // no-op when they already match); the health checks prove it serves.
    log.info(
      `Already on ${current.version}; checking the running containers match and are healthy.`,
    );
    const converged = await startBoth(deps);
    if (!converged.ok) {
      return fail(
        "converge",
        `${converged.error}\nThe recorded release ${current.version} is not serving healthily — check \`docker compose logs\`.`,
        false,
      );
    }
    log.info(`Already on ${current.version} (${shortDigest(images.admin)}); nothing to do.`);
    return { ok: true, status: "already-current", version: current.version };
  }
  // Otherwise (a different target, or a Compose file a stopped run left
  // with other digests) the full flow below converges the install.

  // Rendered before the backup so a config problem stops the run before
  // anything on the host is touched.
  const nextCompose = deps.renderCompose(images);

  // 2. Backup — before anything on the host changes.
  log.step("Backing up the databases (pg_dump)");
  const backup = await backupDatabases(caeloDir, runner, now());
  if (!backup.ok) return fail("backup", backup.error, true);
  log.info(`Backup written to ${backup.dir}`);

  // 3. New digests into the Compose file; pull them.
  writeFileSync(file, nextCompose, { mode: 0o600 });
  log.step("Pulling the new images");
  const pull = await runner.run(
    compose(caeloDir, "pull", COMPOSE_SERVICE.admin, COMPOSE_SERVICE.gateway),
  );
  if (pull.exitCode !== 0) {
    restoreCompose(file, previousCompose);
    return fail("pull", `docker compose pull failed: ${tail(pull.stderr)}`, true);
  }

  // 4. Migrations from the new admin image; the old containers keep serving.
  log.step("Running database migrations with the new admin image");
  const migrated = await runMigrations(caeloDir, runner);
  if (!migrated.ok) {
    restoreCompose(file, previousCompose);
    return fail(
      "migrate",
      `${migrated.error}\nThe previous release keeps running. Database backup: ${backup.dir}`,
      true,
    );
  }

  // 5. Roll admin, then gateway, each health-checked.
  for (const service of RELEASE_SERVICES) {
    const stage = service === "admin" ? "roll-admin" : "roll-gateway";
    log.step(`Restarting ${service} on ${shortDigest(images[service])}`);
    const up = await runner.run(
      compose(caeloDir, "up", "-d", "--no-deps", COMPOSE_SERVICE[service]),
    );
    const healthy =
      up.exitCode === 0
        ? await waitHealthy(service, caeloDir, deps)
        : { ok: false as const, error: `docker compose up failed: ${tail(up.stderr)}` };
    if (!healthy.ok) {
      log.error(`${service} is not healthy on ${target.version}: ${healthy.error}`);
      const restored = await rollback(file, previousCompose, deps);
      if (current) {
        recordRollback(caeloDir, current, target.version, `${stage}: ${healthy.error}`, now());
      }
      return fail(
        stage,
        `${healthy.error}\n${
          restored
            ? "Rolled back: the previous release is running and healthy again."
            : "ROLLBACK FAILED — the previous images did not come back healthy. Check `docker compose ps` / `docker compose logs`."
        }\nDatabase backup: ${backup.dir}`,
        restored,
      );
    }
    log.info(`${service} healthy ✓`);
  }

  // 6. Record.
  recordRelease(
    caeloDir,
    { version: target.version, images },
    { from: current?.version ?? null, to: target.version, outcome: "upgraded" },
    now(),
  );
  log.step(`Upgraded to ${target.version}. Backup kept at ${backup.dir}`);
  return { ok: true, status: "upgraded", version: target.version };
}

function fail(
  stage: UpgradeStage,
  error: string,
  previousRunning: boolean,
): SelfHostedUpgradeResult {
  return { ok: false, stage, error, previousRunning };
}

/** The tag to resolve and the version to record: explicit, channel, or newest stable. */
async function targetVersion(
  opts: SelfHostedUpgradeOpts,
  fetchImpl?: typeof fetch,
): Promise<{ ok: true; tag: string; version: string } | { ok: false; error: string }> {
  if (opts.version || opts.channel === "rc" || opts.channel === "beta") {
    const tag = releaseTag(opts);
    return { ok: true, tag, version: tag };
  }
  const latest = await fetchLatestReleaseTag(fetchImpl);
  if (!latest.ok) {
    return {
      ok: false,
      error: `Could not look up the newest Caelo release (${latest.reason}). Pass --version x.y.z.`,
    };
  }
  const tag = releaseTag({ version: latest.tag });
  return { ok: true, tag, version: tag };
}

/**
 * pg_dump both databases (custom format) plus the cluster's roles into
 * `.caelo/backups/pre-upgrade-<timestamp>/` (mode 700). Every dump must exit
 * 0 and be non-empty, or the upgrade does not start.
 */
export async function backupDatabases(
  caeloDir: string,
  runner: HostRunner,
  at: Date,
): Promise<{ ok: true; dir: string } | { ok: false; error: string }> {
  const ready = await runner.run(
    compose(caeloDir, "exec", "-T", "postgres", "pg_isready", "-U", "caelo"),
  );
  if (ready.exitCode !== 0) {
    return {
      ok: false,
      error:
        "Postgres is not running, so no backup can be taken and the upgrade will not start.\n" +
        `Start it with \`docker compose -f ${composePath(caeloDir)} up -d postgres\` and re-run.`,
    };
  }
  const dir = join(caeloDir, "backups", `pre-upgrade-${at.toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const dumps: [string, string[]][] = [
    ["globals.sql", ["pg_dumpall", "-U", "caelo", "--globals-only"]],
    ["cms_admin.dump", ["pg_dump", "-U", "caelo", "-Fc", "cms_admin"]],
    ["cms_public.dump", ["pg_dump", "-U", "caelo", "-Fc", "cms_public"]],
  ];
  for (const [name, cmd] of dumps) {
    const out = join(dir, name);
    const r = await runner.run(compose(caeloDir, "exec", "-T", "postgres", ...cmd), {
      stdoutPath: out,
    });
    if (r.exitCode !== 0 || !existsSync(out) || statSync(out).size === 0) {
      return {
        ok: false,
        error: `Backup failed (${cmd.join(" ")} → ${out}): ${tail(r.stderr) || "empty dump"}. The upgrade did not start.`,
      };
    }
    chmodSync(out, 0o600);
  }
  return { ok: true, dir };
}

/**
 * Apply the committed migrations (cms_admin, then cms_public) with the
 * admin image the Compose file names, as a one-off container — the
 * self-hosted equivalent of the GCP `caelo-migrate-<target>` Cloud Run job.
 * drizzle's bookkeeping makes re-runs apply only new migrations.
 */
export async function runMigrations(
  caeloDir: string,
  runner: HostRunner,
): Promise<{ ok: true } | { ok: false; error: string }> {
  for (const target of ["admin", "public"] as const) {
    const r = await runner.run(
      compose(
        caeloDir,
        "run",
        "--rm",
        "--no-deps",
        "-T",
        COMPOSE_SERVICE.admin,
        "bun",
        "--bun",
        "/app/packages/migrations/src/migrate.ts",
        target,
      ),
    );
    if (r.exitCode !== 0) {
      return { ok: false, error: `${target} migrations failed: ${tail(r.stderr || r.stdout)}` };
    }
  }
  return { ok: true };
}

/**
 * In-container probe scripts (`bun -e`): the containers publish no host
 * ports, so the probe runs where the service listens. The admin's
 * `/_caelo/health` checks the DB pool + roles; the gateway's `/healthz` is
 * its liveness endpoint.
 */
const HEALTH_PROBE: Record<"admin" | "gateway", string> = {
  admin:
    'const r=await fetch("http://127.0.0.1:"+(process.env.PORT||"3000")+"/_caelo/health").catch(()=>null);process.exit(r&&r.ok?0:1)',
  gateway:
    'const r=await fetch("http://127.0.0.1:"+(process.env.PORT||process.env.GATEWAY_PORT||"8090")+"/healthz").catch(()=>null);process.exit(r&&r.ok?0:1)',
};

async function waitHealthy(
  service: "admin" | "gateway",
  caeloDir: string,
  deps: SelfHostedUpgradeDeps,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const attempts = deps.healthAttempts ?? 45;
  const interval = deps.healthIntervalMs ?? 2000;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let last = "";
  for (let i = 0; i < attempts; i++) {
    const r = await deps.runner.run(
      compose(caeloDir, "exec", "-T", COMPOSE_SERVICE[service], "bun", "-e", HEALTH_PROBE[service]),
    );
    if (r.exitCode === 0) return { ok: true };
    last = tail(r.stderr);
    if (i < attempts - 1) await sleep(interval);
  }
  return {
    ok: false,
    error: `health check did not pass after ${attempts} attempts${last ? ` (${last})` : ""}`,
  };
}

/** Put the previous Compose file back, restart both services on it, health-check them. */
async function rollback(
  file: string,
  previousCompose: string,
  deps: SelfHostedUpgradeDeps,
): Promise<boolean> {
  deps.log.warn("Rolling back to the previous images");
  restoreCompose(file, previousCompose);
  return (await startBoth(deps)).ok;
}

/** `up -d` both services on the current Compose file, then health-check each. */
async function startBoth(
  deps: SelfHostedUpgradeDeps,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const up = await deps.runner.run(
    compose(deps.caeloDir, "up", "-d", "--no-deps", COMPOSE_SERVICE.admin, COMPOSE_SERVICE.gateway),
  );
  if (up.exitCode !== 0)
    return { ok: false, error: `docker compose up failed: ${tail(up.stderr)}` };
  for (const service of RELEASE_SERVICES) {
    const healthy = await waitHealthy(service, deps.caeloDir, deps);
    if (!healthy.ok) return { ok: false, error: `${service}: ${healthy.error}` };
  }
  return { ok: true };
}

function restoreCompose(file: string, previous: string): void {
  writeFileSync(file, previous, { mode: 0o600 });
}

function shortDigest(ref: string): string {
  const at = ref.indexOf("@sha256:");
  return at === -1 ? ref : ref.slice(at + 1, at + 20);
}

function tail(s: string): string {
  return s.trim().split("\n").slice(-5).join("\n").slice(0, 800);
}
