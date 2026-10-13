// SPDX-License-Identifier: MPL-2.0

/**
 * The operator's side of a job-mode GCP install (epic #696, Phase 3;
 * install-job.ts has the design): start the install job after the
 * identity-bound bootstrap, attach to one that runs, or show one that
 * finished — and tail it until it is done.
 *
 * Runs in the operator's terminal with the operator's gcloud login; never
 * in the job itself.
 */

import { CAELO_VERSION } from "@caelo-cms/shared";
import { cancel, confirm, isCancel, log, note } from "@clack/prompts";
import { bold, cyan, dim, green, red, yellow } from "kleur/colors";
import { formatDnsRecordGroups, groupDnsRecords, type InstallDnsRecord } from "../dns/groups.js";
import { activeAccount, gcloud } from "../gcloud.js";
import type { GcloudRunner, Sleep } from "../gcloud-retry.js";
import { realSleep } from "../gcloud-retry.js";
import {
  claimInstallJobStatus,
  decideInstallJob,
  describeExecution,
  INSTALL_JOB_NAME,
  type InstallJobDecision,
  type InstallJobStatus,
  opsImageRef,
  readExecutionLogs,
  readInstallJobStatus,
  readSetupLink,
  startInstallJob,
} from "../install-job.js";
import {
  currentMetadata,
  getStepPayload,
  type InstallMetadata,
  installRoot,
  isStepDone,
  readLocalMetadata,
  readMetadata,
  recordedImageDigests,
  recordImageDigests,
} from "../install-state.js";
import { fetchVerifiedReleaseManifest } from "../release-manifest.js";
import { selfCommand } from "../self-command.js";
import { attachInstall } from "../state-attach.js";
import { hasLocalPulumiState, opsBucketName } from "../state-backend.js";
import { GcsStateStore, realSyncGcloud, type SyncGcloud } from "../state-store.js";
import { promptProjectId } from "./gcp-prompts.js";

/** Side effects of the tail loop, injectable for tests. */
export interface TailDeps {
  readonly run: GcloudRunner;
  readonly syncRun: SyncGcloud;
  readonly sleep: Sleep;
  readonly print: (line: string) => void;
  /** Poll interval in ms. */
  readonly intervalMs: number;
}

const realTailDeps: TailDeps = {
  run: gcloud,
  syncRun: realSyncGcloud,
  sleep: realSleep,
  print: (line) => process.stdout.write(`${line}\n`),
  intervalMs: 5_000,
};

/** Read the bucket's status and the execution's live state, then decide. */
async function decide(
  run: GcloudRunner,
  syncRun: SyncGcloud,
  target: { projectId: string; region: string },
): Promise<InstallJobDecision> {
  const status = readInstallJobStatus(opsBucketName(target.projectId), syncRun);
  const live =
    status && status.state === "running"
      ? await describeExecution(run, { ...target, execution: status.execution })
      : null;
  return decideInstallJob(status, live);
}

/** At most this many polls after the job finished, to catch late log lines. */
const DRAIN_POLLS = 12;
/** ...stopping early after this many polls in a row brought nothing new. */
const DRAIN_QUIET_POLLS = 3;

/** How a tail ended. */
export type TailOutcome =
  | { readonly kind: "succeeded" }
  | { readonly kind: "failed"; readonly status: InstallJobStatus | null; readonly why: string };

/**
 * Follow one execution: print its log lines as Cloud Logging receives
 * them and each phase change from the status document, until the job
 * records `succeeded` / `failed` or the execution ends without doing so.
 */
export async function tailInstallJob(
  target: { projectId: string; region: string; execution: string },
  deps: TailDeps = realTailDeps,
): Promise<TailOutcome> {
  const bucket = opsBucketName(target.projectId);
  const seen = new Set<string>();
  let cursor: string | null = null;
  let lastPhase = "";
  const flush = async (): Promise<number> => {
    const logs = await readExecutionLogs(deps.run, target, cursor, seen);
    cursor = logs.cursor;
    for (const line of logs.lines) deps.print(line);
    return logs.lines.length;
  };
  // Cloud Logging ingests asynchronously: the bucket can say "done" before
  // the job's last lines (its summary, the go-live DNS records) are
  // queryable. Keep reading until a few polls in a row bring nothing new,
  // for at most DRAIN_POLLS polls.
  const drain = async (): Promise<void> => {
    let quiet = 0;
    for (let i = 0; i < DRAIN_POLLS && quiet < DRAIN_QUIET_POLLS; i++) {
      await deps.sleep(deps.intervalMs);
      quiet = (await flush()) === 0 ? quiet + 1 : 0;
    }
  };
  for (let tick = 0; ; tick++) {
    await flush();
    const status = readInstallJobStatus(bucket, deps.syncRun);
    const ours = status?.execution === target.execution ? status : null;
    if (ours && ours.phase !== lastPhase) {
      lastPhase = ours.phase;
      deps.print(bold(cyan(`==> ${ours.phase}`)) + (ours.detail ? `\n    ${ours.detail}` : ""));
    }
    if (ours?.state === "succeeded") {
      await drain();
      return { kind: "succeeded" };
    }
    if (ours?.state === "failed") {
      await drain();
      return { kind: "failed", status: ours, why: ours.detail ?? `stopped at "${ours.phase}"` };
    }
    // The job writes its status as it goes; an execution that died (out of
    // memory, task timeout, cancelled) can't. Check it every few polls.
    if (tick % 6 === 5) {
      const live = await describeExecution(deps.run, target);
      if (live !== "running") {
        await drain();
        const final = readInstallJobStatus(bucket, deps.syncRun);
        if (final?.execution === target.execution && final.state === "succeeded") {
          return { kind: "succeeded" };
        }
        return {
          kind: "failed",
          status: final,
          why:
            final?.execution === target.execution && final.state === "failed"
              ? (final.detail ?? `stopped at "${final.phase}"`)
              : `execution ${target.execution} ended (${live}) without recording a result`,
        };
      }
    }
    await deps.sleep(deps.intervalMs);
  }
}

/** Where the job's full logs are, for every message that sends the operator there. */
function logsHint(projectId: string, region: string): string {
  return `gcloud run jobs executions list --job=${INSTALL_JOB_NAME} --region=${region} --project=${projectId}`;
}

/** Print that closing the tab is fine; exit 130 on Ctrl-C with the re-attach hint. */
function announceDetachable(projectId: string, execution: string): void {
  log.info(
    [
      `The install runs in your project as Cloud Run job ${bold(INSTALL_JOB_NAME)} (execution ${dim(execution)}).`,
      dim(
        "Closing this tab, Ctrl-C or Cloud Shell's idle timeout does not stop it. To follow it again, re-open the",
      ),
      dim(`"Open in Cloud Shell" link (or re-run the same command) and pick project ${projectId}.`),
    ].join("\n"),
  );
  process.once("SIGINT", () => {
    process.stdout.write(
      `\nStopped following. The install keeps running in ${projectId}; re-run to attach again.\n`,
    );
    process.exit(130);
  });
}

/** Tail `execution` and finish the terminal side: the result, or a failure that says what next. */
async function followToTheEnd(meta: InstallMetadata, execution: string): Promise<void> {
  const projectId = meta.projectId ?? "";
  const region = meta.region ?? "";
  announceDetachable(projectId, execution);
  const outcome = await tailInstallJob({ projectId, region, execution });
  if (outcome.kind === "succeeded") {
    await showResult(meta);
    return;
  }
  log.error(red(`The install job failed: ${outcome.why}`));
  log.warn(
    [
      `Fix the cause, then run the installer again — it starts a new run that resumes where this one stopped.`,
      `Full logs: ${logsHint(projectId, region)}`,
    ].join("\n"),
  );
  cancel("Install not finished.");
  process.exit(1);
}

/** The finished install: the Owner setup link (from Secret Manager) and next steps. */
async function showResult(meta: InstallMetadata): Promise<void> {
  const projectId = meta.projectId ?? "";
  const link = await readSetupLink(gcloud, projectId);
  if (!link) {
    cancel(
      `The install finished, but its Owner setup link is not readable in project ${projectId} (Secret Manager). Run the installer again to store it.`,
    );
    process.exit(1);
  }
  const adminBase = new URL(link).origin;
  // The records from the stack's outputs, as the pulumi-up step recorded
  // them — not from the log, which a re-run after the install no longer shows.
  const outputs =
    getStepPayload<{ outputs?: Record<string, unknown> }>(meta.installId, `pulumi-up-${projectId}`)
      ?.outputs ?? {};
  const records = Array.isArray(outputs.dnsRecordsRequiredOut)
    ? (outputs.dnsRecordsRequiredOut as InstallDnsRecord[])
    : [];
  const dnsLines =
    records.length > 0
      ? [
          "",
          bold(`DNS records for ${meta.domain}:`),
          ...formatDnsRecordGroups(groupDnsRecords(records, meta.domain), meta.domain).map(
            (l) => `  ${l}`,
          ),
        ]
      : [];
  note(
    [
      green(`✓ ${meta.domain} is installed.`),
      ...dnsLines,
      "",
      bold("Next steps:"),
      `  1. Owner setup — open in your browser (sign in with ${meta.ownerEmail}):`,
      `     ${cyan(link)}`,
      `  2. AI provider — visit ${cyan(`${adminBase}/settings/ai`)} and paste your Anthropic API key.`,
      `  3. Set the go-live DNS records above once your new site is published`,
      `     (the admin lists them too, at ${cyan(`${adminBase}/settings/domains`)}).`,
      "",
      bold("Later:"),
      `  New releases: ${cyan(`${adminBase}/settings/updates`)} shows how to install them.`,
      `  Manage the install from any machine: ${dim(selfCommand("attach", "--project", projectId))}`,
    ].join("\n"),
    "Done",
  );
}

/**
 * After the bootstrap (gcp.ts, job mode): pin the release, start the job —
 * or attach to / show the one already there — and follow it.
 */
export async function launchInstallJob(opts: {
  installId: string;
  projectId: string;
  region: string;
  provisionerEmail: string;
  nonInteractive: boolean;
}): Promise<void> {
  const { installId, projectId, region } = opts;
  const meta = readMetadata(installId);
  if (!meta) throw new Error(`No install.json for install '${installId}'.`);
  const decision = await decide(gcloud, realSyncGcloud, { projectId, region });
  if (decision.kind === "attach") {
    await followToTheEnd(meta, decision.status.execution);
    return;
  }
  if (decision.kind === "done") {
    await showResult(meta);
    return;
  }
  if (decision.previous) {
    log.warn(yellow(`An earlier install run did not finish: ${decision.why}.`));
    if (!opts.nonInteractive) {
      const again = await confirm({
        message: "Start the install job again? It resumes where the last run stopped.",
        initialValue: true,
      });
      if (isCancel(again) || !again) {
        cancel("Not started.");
        process.exit(0);
      }
    }
  }

  // The release this CLI belongs to, verified against Caelo's release
  // workflow identity: its manifest pins the ops image the job runs and,
  // for a new install, the admin + gateway images it deploys.
  const verified = await fetchVerifiedReleaseManifest(CAELO_VERSION);
  if (!verified.ok) {
    cancel(`Could not verify release v${CAELO_VERSION}: ${verified.error.message}`);
    process.exit(1);
  }
  const { digests } = verified.manifest;
  if (!isStepDone(installId, `pulumi-up-${projectId}`) && !recordedImageDigests(meta)) {
    recordImageDigests(installId, { admin: digests.admin, gateway: digests.gateway });
  }

  const started = await startInstallJob(gcloud, {
    projectId,
    region,
    serviceAccount: opts.provisionerEmail,
    image: opsImageRef(digests.ops),
  });
  if (!started.ok) {
    cancel(`Could not start the install job: ${started.error}`);
    process.exit(1);
  }
  const now = new Date().toISOString();
  // The execution is already running and writes its own status; this one
  // only lands if it hasn't yet, so a re-run started meanwhile attaches
  // instead of starting a second execution (install-job.ts claimInstallJobStatus).
  claimInstallJobStatus(
    opsBucketName(projectId),
    {
      statusVersion: 1,
      installId,
      execution: started.execution,
      state: "running",
      phase: "Starting the install job",
      caeloVersion: CAELO_VERSION,
      startedAt: now,
      updatedAt: now,
    },
    realSyncGcloud,
  );
  await followToTheEnd(meta, started.execution);
}

/** What {@link prepareJobModeInstall} found for the project. */
export type JobModePreparation =
  | { readonly kind: "new"; readonly projectId: string }
  | { readonly kind: "existing"; readonly meta: InstallMetadata }
  | { readonly kind: "handled" };

/**
 * Before any other prompt in job mode: the project comes first, because a
 * Cloud Shell session opened by the button starts with an empty home
 * directory — everything known about an install is in its project. An
 * install whose state is there is attached; one whose job is running is
 * followed and one whose job finished is shown, without re-running the
 * bootstrap. Otherwise the wizard continues (new install, or a re-run of an
 * unfinished bootstrap).
 */
export async function prepareJobModeInstall(opts: {
  projectId?: string;
}): Promise<JobModePreparation> {
  const account = await activeAccount();
  if (!account) {
    cancel(
      "No active gcloud account. Run `gcloud auth login` (in Cloud Shell: the first step of the tutorial), then re-run.",
    );
    process.exit(2);
  }
  log.info(`gcloud auth: ${bold(account)}`);
  const projectId = opts.projectId ?? (await promptProjectId("my-caelo-site"));
  const bucket = opsBucketName(projectId);
  let existing: string | null;
  try {
    existing = new GcsStateStore(bucket, "/nonexistent", realSyncGcloud).peek("install.json");
  } catch (e) {
    cancel(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  if (existing === null) return { kind: "new", projectId };

  const attached = attachInstall(projectId, {
    run: realSyncGcloud,
    rootFor: installRoot,
    hasLocalState: hasLocalPulumiState,
  });
  if (!attached.ok) {
    cancel(attached.error);
    process.exit(1);
  }
  const local = readLocalMetadata(attached.installId);
  if (!local) throw new Error(`attach wrote no install.json for ${attached.installId}`);
  const meta = currentMetadata(local);
  log.success(`Found install ${bold(meta.installId)} (${meta.domain}) in ${projectId}.`);
  if (!meta.region) return { kind: "existing", meta };
  const decision = await decide(gcloud, realSyncGcloud, { projectId, region: meta.region });
  if (decision.kind === "attach") {
    await followToTheEnd(meta, decision.status.execution);
    return { kind: "handled" };
  }
  if (decision.kind === "done") {
    await showResult(meta);
    return { kind: "handled" };
  }
  return { kind: "existing", meta };
}

/**
 * `status`'s view of the install job: what the bucket records and, for a
 * run that claims to be running, whether its execution still is. Empty
 * when the install never used the job.
 */
export async function installJobStatusLines(
  meta: InstallMetadata,
  deps: { run: GcloudRunner; syncRun: SyncGcloud } = { run: gcloud, syncRun: realSyncGcloud },
): Promise<string[]> {
  if (!meta.projectId || !meta.region) return [];
  const status = readInstallJobStatus(opsBucketName(meta.projectId), deps.syncRun);
  if (!status) return [];
  const decision = decideInstallJob(
    status,
    status.state === "running"
      ? await describeExecution(deps.run, {
          projectId: meta.projectId,
          region: meta.region,
          execution: status.execution,
        })
      : null,
  );
  const head = `Install job: ${status.state} — ${status.phase} ${dim(`(v${status.caeloVersion}, execution ${status.execution}, updated ${status.updatedAt})`)}`;
  const lines = [head];
  if (status.detail) lines.push(`  ${status.detail}`);
  if (decision.kind === "attach") {
    lines.push(`  Follow it: re-run the installer for project ${meta.projectId} (it attaches).`);
  } else if (decision.kind === "start") {
    lines.push(
      `  Not finished (${decision.why}). Re-run the installer for project ${meta.projectId}; it resumes where this run stopped.`,
    );
  }
  return lines;
}
