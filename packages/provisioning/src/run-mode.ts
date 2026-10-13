// SPDX-License-Identifier: MPL-2.0

/**
 * Where the long half of a GCP install runs (epic #696, Phase 3):
 *
 *   - `job`   — the operator's terminal does the identity-bound bootstrap
 *               (project, billing, APIs, keyless provisioner, state bucket,
 *               cost y/N), then a Cloud Run job in the install's project
 *               runs `pulumi up`, the DNS + certificate waits and the rest
 *               (install-job.ts). The terminal only tails it.
 *   - `local` — everything runs in this process, as it always has; Pulumi
 *               impersonates the provisioner with the operator's ADC.
 *
 * Default: `job` in Google Cloud Shell, whose session ends after 40 idle
 * minutes and whose home directory the "Open in Cloud Shell" button makes
 * temporary — an install must not depend on that tab. `local` everywhere
 * else, so a laptop / CI run behaves exactly as before. `--local` and
 * `--install-job` override the default either way.
 */

export type RunMode = "job" | "local";

/** Whether this process runs inside Google Cloud Shell (it sets `CLOUD_SHELL=true`). */
export function inCloudShell(env: NodeJS.ProcessEnv): boolean {
  return env.CLOUD_SHELL === "true";
}

/**
 * The run mode for `argv` + `env`.
 *
 * @throws when both `--local` and `--install-job` are given
 */
export function chooseRunMode(argv: readonly string[], env: NodeJS.ProcessEnv): RunMode {
  const local = argv.includes("--local");
  const job = argv.includes("--install-job");
  if (local && job) throw new Error("Pass either --local or --install-job, not both.");
  if (local) return "local";
  if (job) return "job";
  return inCloudShell(env) ? "job" : "local";
}
