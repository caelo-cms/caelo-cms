// SPDX-License-Identifier: MPL-2.0

/**
 * The install job (epic #696, Phase 3): the long half of a GCP install runs
 * as a Cloud Run job in the install's own project instead of in the
 * operator's terminal, so closing the Cloud Shell tab (or its 40-minute idle
 * timeout) never breaks an install.
 *
 * Split of work:
 *   - The operator's terminal (Cloud Shell, or a laptop with
 *     `--install-job`) does everything that needs the operator's own Google
 *     identity: project, billing, APIs, the keyless provisioner SA, the ops
 *     bucket + KMS key, the cost table and its y/N. Then it starts the job
 *     and tails it.
 *   - The job — `caelo-ops install-job --project <id>` from the signed ops
 *     image, pinned by the digest the signed release manifest names, running
 *     AS `caelo-provisioner` (its runtime service account: no key, no
 *     impersonation) — runs `pulumi up`, the DNS + certificate waits,
 *     migrations, the operator-access job and the Owner setup link.
 *
 * Progress lives in the install's ops bucket next to install.json:
 * `install/install-job.json` ({@link InstallJobStatus}) says which execution
 * runs the install and how far it got; progress.json keeps the per-step
 * checkpoints, so a restarted execution resumes where the last one stopped.
 * Re-running the launcher reads the status and attaches to a running
 * execution, shows a finished one, or starts a new one ({@link decideInstallJob}).
 *
 * The Owner setup link is a secret (#656): it never reaches the bucket or
 * the job's logs. The job stores it in Secret Manager
 * ({@link INSTALL_SETUP_LINK_SECRET}); the operator's terminal reads it there.
 */

import { z } from "zod";
import { assertNoSecrets } from "./checkpoint-secrets.js";
import type { GcloudRunner } from "./gcloud-retry.js";
import { GCP_STACK_ENV } from "./gcp-names.js";
import { createInstallSecret } from "./runtime-secrets.js";
import { OPS_INSTALL_PREFIX } from "./state-backend.js";
import type { SyncGcloud } from "./state-store.js";
import { IMAGE_DIGEST } from "./upgrade/release-images.js";

/** Name of the Cloud Run job that runs the install. */
export const INSTALL_JOB_NAME = "caelo-install";

/** Secret Manager secret the job stores the Owner setup link in. */
export const INSTALL_SETUP_LINK_SECRET = "caelo-install-setup-link";

/**
 * Repository of the `caelo-ops` image on the public Artifact Registry
 * mirror. Cloud Run pulls from Artifact Registry, not from GHCR; the mirror
 * carries the same digests and signatures (release-images.yml, `oras copy -r`).
 */
export const OPS_IMAGE_REPOSITORY =
  "europe-west1-docker.pkg.dev/caelo-website/caelo-cms-images/ops";

/**
 * Roles the provisioner needs on top of {@link PROVISIONER_ROLE_LIST} when it
 * runs the install job instead of the operator: the operator-access sync job
 * creates a project custom role and a Cloud Scheduler job (operator-access.ts),
 * and the job's own output has to reach Cloud Logging so the terminal can
 * tail it. Granted only to installs that use the job. Not an escalation: the
 * provisioner already holds `resourcemanager.projectIamAdmin`.
 */
export const INSTALL_JOB_ROLES: readonly string[] = [
  "roles/iam.roleAdmin",
  "roles/cloudscheduler.admin",
  "roles/logging.logWriter",
];

/** Resources the job runs with: Pulumi + the Node language host want memory. */
const JOB_CPU = "2";
const JOB_MEMORY = "4Gi";
/** DNS (operator at the registrar) + certificate waits can each take an hour. */
const JOB_TASK_TIMEOUT = "6h";

/** The ops image pinned by digest. */
export function opsImageRef(digest: string): string {
  if (!IMAGE_DIGEST.test(digest)) throw new Error(`not an image digest: ${digest}`);
  return `${OPS_IMAGE_REPOSITORY}@${digest}`;
}

/** What `install/install-job.json` records. */
export const InstallJobStatusSchema = z.object({
  statusVersion: z.literal(1),
  installId: z.string().min(1),
  /** The Cloud Run execution running (or last running) the install. */
  execution: z.string().min(1),
  state: z.enum(["running", "succeeded", "failed"]),
  /** Human-readable step the job is on, e.g. "Waiting for DNS". */
  phase: z.string(),
  /** Extra context for the phase (the DNS records to set, a failure reason). */
  detail: z.string().optional(),
  /** Caelo release the job's image belongs to. */
  caeloVersion: z.string(),
  startedAt: z.string(),
  updatedAt: z.string(),
});
export type InstallJobStatus = z.infer<typeof InstallJobStatusSchema>;

/** `gs://<bucket>/install/install-job.json`. */
export function installJobStatusUrl(bucket: string): string {
  return `gs://${bucket}/${OPS_INSTALL_PREFIX}/install-job.json`;
}

const NOT_FOUND = /matched no objects|No URLs matched|NotFound|NOT_FOUND|404|does not exist/i;

/**
 * The install job's status as the ops bucket holds it now (never cached:
 * another process — the job — writes it), or null before the first start.
 * Throws when the bucket can't be read or the document is malformed.
 */
export function readInstallJobStatus(bucket: string, run: SyncGcloud): InstallJobStatus | null {
  const url = installJobStatusUrl(bucket);
  const r = run(["storage", "cat", url]);
  if (!r.ok) {
    if (NOT_FOUND.test(r.stderr)) return null;
    throw new Error(`Could not read ${url}: ${r.stderr.trim() || `gcloud exited ${r.exitCode}`}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    throw new Error(`${url} is not valid JSON; remove it and re-run to start the install again.`);
  }
  const parsed = InstallJobStatusSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `${url} is not an install-job status this CLI understands (${parsed.error.message}); remove it and re-run.`,
    );
  }
  return parsed.data;
}

/** Replace the status document. Refuses secret material (#656). */
export function writeInstallJobStatus(
  bucket: string,
  status: InstallJobStatus,
  run: SyncGcloud,
): void {
  const parsed = InstallJobStatusSchema.parse(status);
  assertNoSecrets(parsed, "install-job.json");
  const url = installJobStatusUrl(bucket);
  const r = run(
    ["storage", "cp", "-", url, "--content-type=application/json"],
    `${JSON.stringify(parsed, null, 2)}\n`,
  );
  if (!r.ok) {
    throw new Error(`Could not write ${url}: ${r.stderr.trim() || `gcloud exited ${r.exitCode}`}`);
  }
}

/** Where a Cloud Run execution stands. */
export type ExecutionState = "running" | "succeeded" | "failed" | "missing";

interface ExecutionDescription {
  status?: {
    completionTime?: string;
    succeededCount?: number;
    failedCount?: number;
    cancelledCount?: number;
  };
}

/** Read one execution of the install job. */
export async function describeExecution(
  run: GcloudRunner,
  target: { projectId: string; region: string; execution: string },
): Promise<ExecutionState> {
  const r = await run([
    "run",
    "jobs",
    "executions",
    "describe",
    target.execution,
    `--region=${target.region}`,
    `--project=${target.projectId}`,
    "--format=json",
  ]);
  if (!r.ok) {
    if (NOT_FOUND.test(r.stderr)) return "missing";
    throw new Error(
      `Could not read execution ${target.execution}: ${r.stderr.trim() || `gcloud exited ${r.exitCode}`}`,
    );
  }
  const d = JSON.parse(r.stdout || "{}") as ExecutionDescription;
  const s = d.status ?? {};
  if (!s.completionTime) return "running";
  return (s.succeededCount ?? 0) >= 1 && !s.failedCount && !s.cancelledCount
    ? "succeeded"
    : "failed";
}

/** What the launcher does with an install that may already have a job. */
export type InstallJobDecision =
  | { readonly kind: "start"; readonly previous: InstallJobStatus | null; readonly why: string }
  | { readonly kind: "attach"; readonly status: InstallJobStatus }
  | { readonly kind: "done"; readonly status: InstallJobStatus };

/**
 * Decide from the bucket's status and the execution's live state. Only a
 * status the job itself finished as `succeeded` counts as done; a running
 * status whose execution has ended (crash, out of memory, cancelled, task
 * timeout) is started again — the steps are checkpointed, so a new
 * execution resumes where the last one stopped.
 */
export function decideInstallJob(
  status: InstallJobStatus | null,
  live: ExecutionState | null,
): InstallJobDecision {
  if (!status) return { kind: "start", previous: null, why: "no install job has run yet" };
  if (status.state === "succeeded") return { kind: "done", status };
  if (status.state === "running" && live === "running") return { kind: "attach", status };
  if (status.state === "failed") {
    return {
      kind: "start",
      previous: status,
      why: `the last run stopped at "${status.phase}"${status.detail ? `: ${status.detail}` : ""}`,
    };
  }
  return {
    kind: "start",
    previous: status,
    why: `execution ${status.execution} ended (${live ?? "unknown"}) while at "${status.phase}"`,
  };
}

/** Everything the job definition depends on. */
export interface InstallJobSpec {
  readonly projectId: string;
  readonly region: string;
  /** `caelo-provisioner@<project>` — the job's runtime identity. */
  readonly serviceAccount: string;
  /** {@link opsImageRef} of the release's signed ops image. */
  readonly image: string;
}

/**
 * The `gcloud run jobs deploy` argv: creates the job or replaces its
 * definition (image, args, identity) in place. The only argument the job
 * gets is the project; everything else it reads from the ops bucket.
 */
export function installJobDeployArgs(spec: InstallJobSpec): string[] {
  return [
    "run",
    "jobs",
    "deploy",
    INSTALL_JOB_NAME,
    `--image=${spec.image}`,
    `--region=${spec.region}`,
    `--project=${spec.projectId}`,
    `--service-account=${spec.serviceAccount}`,
    `--args=install-job,--project,${spec.projectId}`,
    "--tasks=1",
    "--max-retries=0",
    `--task-timeout=${JOB_TASK_TIMEOUT}`,
    `--cpu=${JOB_CPU}`,
    `--memory=${JOB_MEMORY}`,
    // Plain log lines: no colour codes, no spinner frames.
    "--set-env-vars=NO_COLOR=1,CI=true",
    "--labels=caelo-role=install",
    "--quiet",
  ];
}

/** Create or update the job, then start one execution of it. */
export async function startInstallJob(
  run: GcloudRunner,
  spec: InstallJobSpec,
): Promise<{ ok: true; execution: string } | { ok: false; error: string }> {
  const deploy = await run(installJobDeployArgs(spec));
  if (!deploy.ok) {
    return { ok: false, error: `create the install job: ${deploy.stderr.trim()}` };
  }
  const exec = await run([
    "run",
    "jobs",
    "execute",
    INSTALL_JOB_NAME,
    `--region=${spec.region}`,
    `--project=${spec.projectId}`,
    "--async",
    "--format=value(metadata.name)",
  ]);
  if (!exec.ok) return { ok: false, error: `start the install job: ${exec.stderr.trim()}` };
  // gcloud prints the resource with --format on stdout; older releases only
  // announce "Execution [name] has successfully started" on stderr.
  const execution =
    exec.stdout.trim().split(/\s+/)[0] || /Execution \[([^\]]+)\]/.exec(exec.stderr)?.[1] || "";
  if (!/^[a-z0-9-]+$/.test(execution)) {
    return {
      ok: false,
      error: `the install job started but gcloud did not name the execution (${exec.stderr.trim()})`,
    };
  }
  return { ok: true, execution };
}

/** One log line of the job, as Cloud Logging returns it. */
interface LogEntry {
  insertId?: string;
  timestamp?: string;
  textPayload?: string;
}

/**
 * The execution's log lines newer than `since` (an RFC 3339 timestamp, or
 * null for all), oldest first. `seen` holds insert ids already printed —
 * entries sharing a timestamp would otherwise repeat or go missing.
 */
export async function readExecutionLogs(
  run: GcloudRunner,
  target: { projectId: string; execution: string },
  since: string | null,
  seen: Set<string>,
): Promise<{ lines: string[]; cursor: string | null }> {
  const filter = [
    'resource.type="cloud_run_job"',
    `resource.labels.job_name="${INSTALL_JOB_NAME}"`,
    `labels."run.googleapis.com/execution_name"="${target.execution}"`,
    ...(since ? [`timestamp>="${since}"`] : []),
  ].join(" AND ");
  const r = await run([
    "logging",
    "read",
    filter,
    `--project=${target.projectId}`,
    "--order=asc",
    "--limit=1000",
    "--freshness=1d",
    "--format=json",
  ]);
  if (!r.ok) return { lines: [], cursor: since };
  const entries = JSON.parse(r.stdout || "[]") as LogEntry[];
  const lines: string[] = [];
  let cursor = since;
  for (const e of entries) {
    const id = e.insertId ?? `${e.timestamp}:${e.textPayload}`;
    if (seen.has(id)) continue;
    seen.add(id);
    if (e.timestamp) cursor = e.timestamp;
    if (e.textPayload !== undefined) lines.push(e.textPayload.replace(/\n$/, ""));
  }
  return { lines, cursor };
}

/**
 * Store the Owner setup link in {@link INSTALL_SETUP_LINK_SECRET} (created
 * with the install's secret replication if missing) and disable the versions before it, so
 * one link — the newest — is readable.
 */
export async function storeSetupLink(
  run: GcloudRunner,
  target: { projectId: string; region: string },
  link: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const project = `--project=${target.projectId}`;
  const exists = await run([
    "secrets",
    "describe",
    INSTALL_SETUP_LINK_SECRET,
    project,
    "--format=value(name)",
  ]);
  if (!exists.ok) {
    const created = await createInstallSecret(
      { ...target, env: GCP_STACK_ENV, secretId: INSTALL_SETUP_LINK_SECRET },
      { run },
    );
    if (!created.ok) return created;
  }
  const add = await run(
    [
      "secrets",
      "versions",
      "add",
      INSTALL_SETUP_LINK_SECRET,
      project,
      "--data-file=-",
      "--format=value(name)",
    ],
    { stdin: link },
  );
  if (!add.ok) {
    return { ok: false, error: `store the setup link: ${add.stderr.trim()}` };
  }
  const newest = add.stdout.trim().split("/").pop() ?? "";
  const enabled = await run([
    "secrets",
    "versions",
    "list",
    INSTALL_SETUP_LINK_SECRET,
    project,
    "--filter=state:enabled",
    "--format=value(name)",
  ]);
  for (const name of enabled.ok ? enabled.stdout.split("\n") : []) {
    const version = name.trim().split("/").pop() ?? "";
    if (version === "" || version === newest) continue;
    await run([
      "secrets",
      "versions",
      "disable",
      version,
      `--secret=${INSTALL_SETUP_LINK_SECRET}`,
      project,
      "--quiet",
    ]);
  }
  return { ok: true };
}

/** The Owner setup link the job stored, or null when there is none yet. */
export async function readSetupLink(run: GcloudRunner, projectId: string): Promise<string | null> {
  const r = await run([
    "secrets",
    "versions",
    "access",
    "latest",
    `--secret=${INSTALL_SETUP_LINK_SECRET}`,
    `--project=${projectId}`,
  ]);
  return r.ok && r.stdout.trim() !== "" ? r.stdout.trim() : null;
}
