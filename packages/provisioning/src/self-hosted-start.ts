// SPDX-License-Identifier: MPL-2.0

/**
 * Start (or converge) a self-hosted Compose install — what `init` and `up`
 * run after writing `.caelo/`, so one command ends with a serving install
 * (CLAUDE.md §11.C, issue #707) instead of printing steps to copy.
 *
 * Order, and why:
 *   1. pull every image, with the progress on the terminal (the admin image
 *      is large; a silent multi-minute step reads as a hang);
 *   2. start Postgres and wait for its health check — on a fresh volume its
 *      first start runs bootstrap.sh (roles + databases);
 *   3. apply the migrations with the install's admin image;
 *   4. start everything (`--remove-orphans` drops services an older Compose
 *      file had, e.g. the pgBackRest sidecar);
 *   5. health-check the admin (`/_caelo/health` proves the DB pool and its
 *      role) and the gateway;
 *   6. reload Caddy — Compose does not restart a running Caddy when only
 *      its bind-mounted Caddyfile changed, so a re-run `up` would otherwise
 *      keep serving the old vhosts.
 * Every step converges, so a re-run after a failure picks up where it
 * stopped.
 */

import type { HostRunner } from "./self-hosted-release.js";
import { compose, runMigrations, waitHealthy } from "./self-hosted-upgrade.js";

export interface StartDeps {
  readonly caeloDir: string;
  readonly runner: HostRunner;
  readonly log: (message: string) => void;
  /** Health probe attempts per service and the pause between them. */
  readonly healthAttempts?: number;
  readonly healthIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export type StartResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly stage: StartStage; readonly error: string };

type StartStage = "pull" | "postgres" | "migrate" | "start" | "health" | "caddy";

/** Bring the install's Compose stack up and prove it serves. Never throws for an expected failure. */
export async function startSelfHosted(deps: StartDeps): Promise<StartResult> {
  const { caeloDir, runner, log } = deps;
  log("Pulling the images …");
  const pull = await runner.run(compose(caeloDir, "pull"), { inherit: true });
  if (pull.exitCode !== 0) {
    return fail("pull", "docker compose pull failed (see above). Check the network and re-run.");
  }

  log("Starting Postgres …");
  const pg = await runner.run(compose(caeloDir, "up", "-d", "--wait", "postgres"), {
    inherit: true,
  });
  if (pg.exitCode !== 0) {
    return fail(
      "postgres",
      `Postgres did not become healthy (see above; \`docker compose -f ${caeloDir}/docker-compose.yml logs postgres\`).`,
    );
  }

  log("Applying the database migrations …");
  const migrated = await runMigrations(caeloDir, runner);
  if (!migrated.ok) return fail("migrate", migrated.error);

  log("Starting Caddy, the admin and the gateway …");
  const up = await runner.run(compose(caeloDir, "up", "-d", "--remove-orphans"), {
    inherit: true,
  });
  if (up.exitCode !== 0) return fail("start", "docker compose up failed (see above).");

  for (const service of ["admin", "gateway"] as const) {
    log(`Waiting for the ${service} to answer its health check …`);
    const healthy = await waitHealthy(service, caeloDir, {
      runner,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      ...(deps.healthAttempts !== undefined ? { healthAttempts: deps.healthAttempts } : {}),
      ...(deps.healthIntervalMs !== undefined ? { healthIntervalMs: deps.healthIntervalMs } : {}),
    });
    if (!healthy.ok) {
      return fail(
        "health",
        `The ${service} is not healthy: ${healthy.error}. See \`docker compose -f ${caeloDir}/docker-compose.yml logs caelo-${service}\`.`,
      );
    }
  }
  log("Reloading Caddy …");
  const reloaded = await reloadCaddy(caeloDir, runner);
  if (!reloaded.ok) return fail("caddy", reloaded.error);
  return { ok: true };
}

/** `caddy reload` in the running Caddy container with the current Caddyfile. */
export async function reloadCaddy(
  caeloDir: string,
  runner: HostRunner,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await runner.run(
    compose(
      caeloDir,
      "exec",
      "-T",
      "caddy",
      "caddy",
      "reload",
      "--config",
      "/etc/caddy/Caddyfile",
      "--adapter",
      "caddyfile",
    ),
  );
  if (r.exitCode === 0) return { ok: true };
  return {
    ok: false,
    error: `caddy reload failed: ${r.stderr.trim().split("\n").slice(-3).join("\n")}`,
  };
}

function fail(stage: StartStage, error: string): StartResult {
  return { ok: false, stage, error };
}
