// SPDX-License-Identifier: MPL-2.0

/**
 * The Cloud Run side of an update job's hand-over (job-handover.ts): what
 * the converge job (#819) and the upgrader job (#1029) do to themselves, as
 * their own service accounts. Each holds exactly this on its own job:
 * `run.jobs.update` and `run.jobs.run`, without `run.jobs.runWithOverrides`,
 * and `actAs` on its own account.
 *
 * Two gcloud calls change anything, and tests pin both: `jobs update` with
 * `--image` by digest and no other setting, and `jobs execute` with no flag
 * that overrides the job's args or env.
 */

import type { GcloudRunner } from "./gcloud-retry.js";
import { describeExecution } from "./install-job.js";
import type { SelfHandoverDeps } from "./job-handover.js";
import { releaseImageRef, verifyCosignAll } from "./upgrade/release-images.js";

const DIGEST = /@(sha256:[0-9a-f]{64})/;

/**
 * The image digest an execution of an update job runs, from its Cloud Run
 * description (the execution's task template names the image it was
 * started with). Null when it cannot be read or names no digest.
 */
export function executionImageDigest(describeJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(describeJson);
  } catch {
    return null;
  }
  // gcloud prints the v1 resource (spec.template.spec.containers); the v2
  // shape (template.containers) is accepted too. The first container is it.
  const p = parsed as {
    spec?: { template?: { spec?: { containers?: { image?: string }[] } } };
    template?: { containers?: { image?: string }[] };
  };
  const image =
    p.spec?.template?.spec?.containers?.[0]?.image ?? p.template?.containers?.[0]?.image ?? "";
  return DIGEST.exec(image)?.[1] ?? null;
}

/**
 * Why `CLOUD_RUN_EXECUTION` cannot name a run of `job`, or null when it
 * can. The name keys the state lock's holder and the hand-over between the
 * job's two stages, so a value that names another job's run (or is not a
 * Cloud Run name at all) stops the job before it acts (#883 review). Cloud
 * Run sets it and rejects user values for it; this is the second line.
 */
export function jobExecutionNameError(job: string, execution: string | null): string | null {
  if (execution === null) return null;
  if (!/^[a-z0-9-]{1,63}$/.test(execution) || !execution.startsWith(`${job}-`)) {
    return `CLOUD_RUN_EXECUTION is "${execution.slice(0, 80)}", not a run of ${job}`;
  }
  return null;
}

/** The new execution's name from `gcloud run jobs execute --async`. */
export function startedExecutionName(stdout: string, stderr: string): string | null {
  const name = stdout.trim().split(/\s+/)[0] || /Execution \[([^\]]+)\]/.exec(stderr)?.[1] || "";
  return /^[a-z0-9-]+$/.test(name) ? name : null;
}

/**
 * The real {@link SelfHandoverDeps} of update job `job`, except its version
 * (the caller's image knows it).
 */
export function selfHandoverDeps(
  run: GcloudRunner,
  target: {
    readonly job: string;
    readonly projectId: string;
    readonly region: string;
    readonly execution: string | null;
  },
): Omit<SelfHandoverDeps, "ownVersion"> {
  const { job, projectId, region, execution } = target;
  const location = [`--region=${region}`, `--project=${projectId}`];
  return {
    execution,
    verifyImage: (slug, digest) => verifyCosignAll([{ slug, digest }]),
    ownImageDigest: async () => {
      if (!execution) return null;
      const r = await run([
        "run",
        "jobs",
        "executions",
        "describe",
        execution,
        ...location,
        "--format=json",
      ]);
      return r.ok ? executionImageDigest(r.stdout) : null;
    },
    pointJobAt: async (digest) => {
      // Only the image changes: the identity, command and args stay what
      // the job's setup deployed.
      const update = await run([
        "run",
        "jobs",
        "update",
        job,
        `--image=${releaseImageRef("ops", digest)}`,
        ...location,
        "--quiet",
      ]);
      return update.ok
        ? { ok: true }
        : { ok: false, error: `update ${job}: ${update.stderr.trim()}` };
    },
    startJob: async () => {
      const exec = await run([
        "run",
        "jobs",
        "execute",
        job,
        ...location,
        "--async",
        "--format=value(metadata.name)",
      ]);
      if (!exec.ok) return { ok: false, error: `start ${job}: ${exec.stderr.trim()}` };
      const started = startedExecutionName(exec.stdout, exec.stderr);
      if (!started) {
        return {
          ok: false,
          error: `${job} started but gcloud did not name the execution (${exec.stderr.trim()})`,
        };
      }
      return { ok: true, execution: started };
    },
    executionState: (name) => describeExecution(run, { projectId, region, execution: name }),
  };
}
