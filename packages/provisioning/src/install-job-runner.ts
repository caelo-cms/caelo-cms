// SPDX-License-Identifier: MPL-2.0

/**
 * `caelo-ops install-job --project <id>` — the install job's entry point
 * (epic #696, Phase 3; install-job.ts has the design). Runs inside the Cloud
 * Run job, as `caelo-provisioner`, from the signed ops image:
 *
 *   1. attach the install from its ops bucket (the container starts empty);
 *   2. record `running` in `install/install-job.json`;
 *   3. run the converge half of the GCP install (wizards/gcp.ts
 *      runGcpConverge) non-interactively, recording each phase;
 *   4. record `succeeded` — or, from an exit hook, `failed` with the last
 *      lines of output, whatever made the process stop.
 *
 * It takes the project and nothing else: every input is the install's own
 * record in its bucket, which only the operator and the provisioner can write.
 */

import { CAELO_VERSION } from "@caelo-cms/shared";
import { assertNoSecrets } from "./checkpoint-secrets.js";
import {
  type InstallJobStatus,
  readInstallJobStatus,
  writeInstallJobStatus,
} from "./install-job.js";
import { currentMetadata, installRoot, readLocalMetadata } from "./install-state.js";
import { attachInstall } from "./state-attach.js";
import { hasLocalPulumiState, opsBucketName, resolveBackend } from "./state-backend.js";
import { realSyncGcloud, type SyncGcloud } from "./state-store.js";

const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");

/** The `--project` value of `argv`, validated. */
export function installJobProject(argv: readonly string[]): string {
  const i = argv.indexOf("--project");
  const value = i === -1 ? undefined : argv[i + 1];
  if (!value || !PROJECT_ID.test(value)) {
    throw new Error("install-job needs --project <gcp-project-id>");
  }
  return value;
}

/**
 * The failure detail recorded for the operator's terminal: the last
 * non-empty lines of output, colour codes stripped, credentials removed.
 * Anything the secrets guard still objects to is replaced by a pointer to
 * the logs rather than written to the bucket.
 */
export function failureDetail(lines: readonly string[], code: number): string {
  const tail = lines
    .map((l) => l.replace(ANSI, "").trim())
    .filter((l) => l !== "" && !/^[│┌└◇◆●■▲]+$/.test(l))
    .slice(-6)
    .join(" | ");
  // Stricter than redactCredentials' `user:***@`, which the bucket's guard
  // still (rightly) reads as a credential URL: drop the password and any
  // token-like query value entirely.
  const detail = `exit ${code}: ${tail}`
    .replace(/([a-z][a-z0-9+.-]{0,31}:\/\/[^\s:@/]*):[^\s@/]+@/gi, "$1@")
    .replace(
      /([?&](?:token|secret|password|passwd|pwd|api[_-]?key|access[_-]?key|sig|signature)=)[^&\s#]+/gi,
      "$1",
    )
    .slice(0, 1500);
  try {
    assertNoSecrets({ detail }, "install-job.json detail");
    return detail;
  } catch {
    return `exit ${code} — see the job's logs`;
  }
}

/** Keep the last `max` lines written to stdout + stderr. */
function captureOutputTail(max: number): () => string[] {
  const lines: string[] = [];
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
    stream.write = ((chunk: unknown, ...rest: unknown[]) => {
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString();
      for (const l of text.split(/\r?\n/)) if (l.trim() !== "") lines.push(l);
      if (lines.length > max) lines.splice(0, lines.length - max);
      return write(chunk, ...rest);
    }) as typeof stream.write;
  }
  return () => [...lines];
}

/** Run the install job for `--project` in `argv`. */
export async function installJobCommand(
  argv: readonly string[],
  run: SyncGcloud = realSyncGcloud,
): Promise<void> {
  const projectId = installJobProject(argv);
  const attached = attachInstall(projectId, {
    run,
    rootFor: installRoot,
    hasLocalState: hasLocalPulumiState,
  });
  if (!attached.ok) throw new Error(attached.error);
  const local = readLocalMetadata(attached.installId);
  if (!local) throw new Error(`attach wrote no install.json for ${attached.installId}`);
  const meta = currentMetadata(local);
  if (meta.provider !== "gcp" && meta.provider !== "gcp-firebase") {
    throw new Error(`install-job runs gcp / gcp-firebase installs; this one is ${meta.provider}.`);
  }
  if (!meta.region) throw new Error(`install.json of ${meta.installId} records no region.`);

  const bucket = opsBucketName(projectId);
  // Cloud Run sets it; the launcher recorded the same name when it started us.
  const execution = process.env.CLOUD_RUN_EXECUTION ?? "local-run";
  const previous = readInstallJobStatus(bucket, run);
  const now = new Date().toISOString();
  let status: InstallJobStatus = {
    statusVersion: 1,
    installId: meta.installId,
    execution,
    state: "running",
    phase: "Starting",
    caeloVersion: CAELO_VERSION,
    startedAt: previous?.execution === execution ? previous.startedAt : now,
    updatedAt: now,
  };
  const record = (patch: Partial<InstallJobStatus>): void => {
    status = { ...status, ...patch, updatedAt: new Date().toISOString() };
    if (patch.detail === undefined) delete status.detail;
    try {
      writeInstallJobStatus(bucket, status, run);
    } catch (e) {
      // The install goes on; the terminal falls back to the execution state.
      console.error(`could not record progress: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  record({});

  const outputTail = captureOutputTail(40);
  // The wizard's steps end the process with process.exit on failure; the
  // hook runs synchronously (the bucket write is a spawnSync) either way.
  process.on("exit", (code) => {
    if (status.state !== "running") return;
    record({ state: "failed", detail: failureDetail(outputTail(), code) });
  });

  const backend = resolveBackend(meta, {
    installRoot: installRoot(meta.installId),
    readPassphrase: () => null,
  });
  if (backend.kind !== "gcs") {
    throw new Error(
      `${meta.installId}'s state is not in its ops bucket; run the installer with --local.`,
    );
  }
  const { runGcpConverge } = await import("./wizards/gcp.js");
  await runGcpConverge({
    installId: meta.installId,
    projectId,
    region: meta.region,
    provider: meta.provider,
    impersonateServiceAccount: null,
    backend,
    nonInteractive: true,
    setupLink: "secret",
    onPhase: (phase, detail) => record({ phase, detail }),
  });
  record({ state: "succeeded", phase: "Done" });
}
