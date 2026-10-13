// SPDX-License-Identifier: MPL-2.0

/**
 * `cms-provision state migrate` (#696): move an existing install's Pulumi
 * state, secrets provider and install metadata between this machine
 * (`~/.caelo-<id>/state` + passphrase) and the install's own GCP project
 * (`gs://<project>-caelo-ops` + Cloud KMS), in either direction.
 *
 * The source stays authoritative until the very end:
 *
 *   1. preflight — Pulumi CLI version (`pulumi stack migrate` from
 *      {@link STACK_MIGRATE_MIN_VERSION}, else export/import +
 *      change-secrets-provider), the source stack exists, has no pending
 *      operations, and a preview of it shows no changes (an unconverged
 *      stack can't prove the copy is identical, so it is refused);
 *   2. a mode-600 archive of `~/.caelo-<id>/` (tar.zst, else tar.gz);
 *   3. the target: bucket + KMS key ensured (remote) or an empty local
 *      state dir + passphrase (local); a leftover copy from an interrupted
 *      run is removed — it was never authoritative;
 *   4. copy, re-encrypting the secrets for the target's provider;
 *   5. verify — a preview of the target shows no changes and its outputs
 *      (secrets included) hash identically to the source's; on any
 *      mismatch the target copy is removed and nothing else changes;
 *   6. flip — install.json records the new backend (locally and in the
 *      bucket); the old local state dir is renamed, never deleted.
 *
 * `--dry-run` runs the read-only preflight and reports what it would do.
 * The engine takes its side effects as {@link MigrateDeps} so the whole
 * sequence is tested against fakes (state-migrate.test.ts); state-command.ts
 * wires the real Pulumi CLI, gcloud and file system.
 */

import type { OpsBackendResult } from "./ops-backend.js";
import { selfCommand } from "./self-command.js";
import {
  describeBackend,
  type GcsBackendRecord,
  gcsBackendRecord,
  installBackend,
  type ResolvedBackend,
  type StateBackendRecord,
} from "./state-backend.js";
import type { UpgradeReporter } from "./upgrade/reporter.js";

/** First Pulumi CLI release with `pulumi stack migrate` between DIY backends. */
export const STACK_MIGRATE_MIN_VERSION = "3.254.0";

/** What the ops bucket + KMS key cost (wizards/gcp-cost.ts carries the same line). */
export const OPS_BACKEND_COST_NOTE =
  "Creates (if missing) a versioned Cloud Storage bucket + one Cloud KMS key in the install's project: < $0.10/mo (KMS key version $0.06/mo, a few MB of state).";

/** The Pulumi operations a migration needs, against one backend at a time. */
export interface StatePulumiOps {
  /** `pulumi version` without the `v`, or null when the CLI is missing. */
  cliVersion(): Promise<string | null>;
  stackExists(backend: ResolvedBackend): Promise<boolean>;
  /** Pending operations recorded in the stack's state (an interrupted run). */
  pendingOperations(backend: ResolvedBackend): Promise<number>;
  /** Steps a preview would take other than "same". */
  previewChanges(backend: ResolvedBackend): Promise<number>;
  /** sha256 of the stack outputs, secrets included. Never the values. */
  outputsDigest(backend: ResolvedBackend): Promise<string>;
  /** sha256 of the stack's exported checkpoint (ciphertext; never decrypted). */
  stateDigest(backend: ResolvedBackend): Promise<string>;
  /** `pulumi stack migrate <from> --secrets-provider <to's>` into `to`. */
  stackMigrate(from: ResolvedBackend, to: ResolvedBackend): Promise<void>;
  /** export → init → import → change-secrets-provider (older CLIs). */
  exportImport(from: ResolvedBackend, to: ResolvedBackend): Promise<void>;
  /** Remove the stack's state from `backend` (cloud resources untouched). */
  removeStack(backend: ResolvedBackend): Promise<void>;
}

/** Everything the migration touches outside Pulumi. */
export interface MigrateDeps {
  readonly pulumi: StatePulumiOps;
  readonly report: UpgradeReporter;
  /** The install's backend resolved for Pulumi. */
  resolve(record: StateBackendRecord): ResolvedBackend;
  /** Ask the operator to accept the ops backend's cost; false = cancel. */
  confirmCost(note: string): Promise<boolean>;
  /** Ensure (or, dry, inspect) the ops bucket + KMS key. */
  ensureRemote(dryRun: boolean): Promise<OpsBackendResult>;
  /** Archive `~/.caelo-<id>/`; returns the archive's path. */
  backup(): Promise<string>;
  /** Whether the local state dir is absent or holds no stack. */
  localStateEmpty(): boolean;
  /** Create the local state dir (mode 700) and `secrets/pulumi-passphrase` if missing. */
  prepareLocalTarget(): void;
  /**
   * The backend the bucket's install.json names (`null` when the bucket or
   * the document doesn't exist). `gcs` there means the bucket copy is
   * authoritative — some machine finished a migration — and must never be
   * replaced from this machine's (then stale) local state.
   */
  remoteRecordedBackend(): StateBackendRecord["kind"] | null;
  /** Record the new backend (install-state.ts adoptStateBackend). */
  adopt(record: StateBackendRecord): void;
  /**
   * Take the install's migration lock (an object in the ops bucket created
   * only if absent); throws when another migration holds it. Returns the
   * release function.
   */
  lock(): Promise<() => Promise<void>>;
  /** Rename the local state dir out of the way; returns where it went. */
  retireLocalState(): string | null;
}

export interface MigrateOptions {
  readonly to: "remote" | "local";
  readonly dryRun: boolean;
}

export type MigrateResult =
  | { readonly ok: true; readonly changed: boolean }
  | { readonly ok: false; readonly error: string };

/** The subset of install metadata a migration reads. */
export interface MigrateInstall {
  readonly installId: string;
  readonly provider: string;
  readonly projectId: string | null;
  readonly region: string | null;
  readonly stateBackend?: StateBackendRecord;
}

/** a >= b for dotted numeric versions (`3.254.0`). */
export function versionAtLeast(a: string, b: string): boolean {
  const pa = a.replace(/^v/, "").split(/[.+-]/).map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (Number.isNaN(x)) return false;
    if (x !== y) return x > y;
  }
  return true;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Run the migration. Never throws for an expected failure: the result says
 * what failed, and at every failure point the source backend is still the
 * one install.json names.
 */
export async function migrateState(
  meta: MigrateInstall,
  opts: MigrateOptions,
  deps: MigrateDeps,
): Promise<MigrateResult> {
  const { report, pulumi } = deps;
  if (meta.provider !== "gcp" && meta.provider !== "gcp-firebase") {
    return {
      ok: false,
      error: `${meta.provider} installs keep their state on the host; there is nothing to migrate.`,
    };
  }
  if (!meta.projectId || !meta.region) {
    return {
      ok: false,
      error: `install.json of ${meta.installId} has no projectId/region; re-run the installer first.`,
    };
  }
  const projectId = meta.projectId;
  const current = installBackend(meta);
  const wantKind = opts.to === "remote" ? "gcs" : "local";
  if (current.kind === wantKind) {
    report.success(
      `Already ${opts.to}: ${describeBackend(meta, `~/.caelo-${meta.installId}`)}. Nothing to do.`,
    );
    return { ok: true, changed: false };
  }
  const remoteRecord: GcsBackendRecord =
    current.kind === "gcs" ? current : gcsBackendRecord(meta.projectId, meta.region);
  const targetRecord: StateBackendRecord = opts.to === "remote" ? remoteRecord : { kind: "local" };

  // --- 1. Preflight (read-only) ------------------------------------------
  if (opts.to === "remote") {
    let recorded: StateBackendRecord["kind"] | null;
    try {
      recorded = deps.remoteRecordedBackend();
    } catch (e) {
      return { ok: false, error: `${errorText(e)}. Nothing was changed.` };
    }
    if (recorded === "gcs") {
      return {
        ok: false,
        error: `gs://${remoteRecord.bucket}/install/install.json says this install's state already lives in the bucket — another machine migrated it, so the local state here is out of date. Nothing was changed. Use the bucket instead: ${selfCommand("attach", "--project", projectId)} (after moving ~/.caelo-${meta.installId} aside).`,
      };
    }
  }
  const pre = report.step("Preflight: Pulumi CLI, source stack, pending operations, drift");
  let from: ResolvedBackend;
  let mode: "stack-migrate" | "export-import";
  let sourceDigest: string;
  /** The source's checkpoint, to notice another run writing it meanwhile. */
  let sourceState: string;
  try {
    const version = await pulumi.cliVersion();
    if (!version) {
      pre.failed("The pulumi CLI is not installed");
      return {
        ok: false,
        error: "Install the Pulumi CLI (https://www.pulumi.com/docs/install/) and re-run.",
      };
    }
    mode = versionAtLeast(version, STACK_MIGRATE_MIN_VERSION) ? "stack-migrate" : "export-import";
    from = deps.resolve(current);
    if (!(await pulumi.stackExists(from))) {
      pre.failed("No stack in the source backend");
      return {
        ok: false,
        error: `The install's stack is not in ${from.url}. Nothing was changed.`,
      };
    }
    const pending = await pulumi.pendingOperations(from);
    if (pending > 0) {
      pre.failed(`${pending} pending operation(s) from an interrupted run`);
      return {
        ok: false,
        error: `The stack records ${pending} pending operation(s) from an interrupted Pulumi run. Run upgrade first, then re-run the installer (${selfCommand()}, pick this install) so the stack is refreshed, and migrate after that. Nothing was changed.`,
      };
    }
    const drift = await pulumi.previewChanges(from);
    if (drift > 0) {
      pre.failed(`A preview shows ${drift} change(s)`);
      return {
        ok: false,
        error: `The stack is not converged (a preview shows ${drift} change(s)), so a copy can't be proven identical. Run upgrade first, then re-run the installer (${selfCommand()}, pick this install) until it reports no changes, and migrate after that. Nothing was changed.`,
      };
    }
    sourceDigest = await pulumi.outputsDigest(from);
    sourceState = await pulumi.stateDigest(from);
    pre.done(
      `Source ok: ${from.url}, no pending operations, no drift (Pulumi ${version}, ${mode === "stack-migrate" ? "pulumi stack migrate" : "export/import fallback"})`,
    );
  } catch (e) {
    pre.failed("Preflight failed");
    return { ok: false, error: `${errorText(e)}. Nothing was changed.` };
  }

  // --- Dry run: report and stop -----------------------------------------
  if (opts.dryRun) {
    const plan: string[] = [`back up ~/.caelo-${meta.installId}/ (mode 600 archive)`];
    if (opts.to === "remote") {
      const r = await deps.ensureRemote(true);
      if (!r.ok) return { ok: false, error: r.error };
      plan.push(...r.actions);
    } else {
      if (!deps.localStateEmpty()) {
        plan.push(
          "would move the unused stack in ~/.caelo-<id>/state aside (state.migrated-<time>, kept) — a leftover of an interrupted migration",
        );
      }
      plan.push("would create ~/.caelo-<id>/state and secrets/pulumi-passphrase if missing");
    }
    plan.push(
      `would copy the stack ${from.url} → ${opts.to === "remote" ? `gs://${remoteRecord.bucket}` : "~/.caelo-<id>/state"} (${mode}), re-encrypting its secrets`,
      "would verify: preview shows no changes, outputs hash identical",
      `would record stateBackend=${targetRecord.kind} in install.json${opts.to === "remote" ? " (locally and in the bucket)" : ""}`,
      ...(opts.to === "remote"
        ? ["would rename ~/.caelo-<id>/state to state.migrated-<time> (kept)"]
        : []),
    );
    report.info(
      ["Dry run — nothing changed. The migration would:", ...plan.map((p) => `  ${p}`)].join("\n"),
    );
    return { ok: true, changed: false };
  }

  // --- 2. Backup -----------------------------------------------------------
  const bk = report.step(`Backing up ~/.caelo-${meta.installId}/`);
  try {
    bk.done(`Backup: ${await deps.backup()} (mode 600; holds the passphrase — keep it private)`);
  } catch (e) {
    bk.failed("Backup failed");
    return { ok: false, error: `${errorText(e)}. Nothing was changed.` };
  }

  // --- 3a. Ops bucket + KMS key (remote), then the migration lock ----------
  if (opts.to === "remote") {
    // CLAUDE.md §11.C — nothing billable without the operator's yes.
    if (!(await deps.confirmCost(OPS_BACKEND_COST_NOTE))) {
      return { ok: false, error: "Cancelled at the cost confirmation. Only the backup was taken." };
    }
    const en = report.step(
      `Ensuring gs://${remoteRecord.bucket} + KMS key ${remoteRecord.kmsKey.split("/").slice(-3).join("/")}`,
    );
    const r = await deps.ensureRemote(false);
    if (!r.ok) {
      en.failed("Could not ensure the ops bucket + KMS key");
      return { ok: false, error: `${r.error} Nothing else was changed.` };
    }
    en.done(`gs://${remoteRecord.bucket} + KMS key ready`);
  }
  // One migration of an install at a time, across machines: held from the
  // authority check through the flip, so a concurrent run can't take a copy
  // the other just made authoritative for a leftover and remove it.
  let release: () => Promise<void>;
  try {
    release = await deps.lock();
  } catch (e) {
    return { ok: false, error: `${errorText(e)}. Nothing else was changed.` };
  }
  try {
    const recorded = deps.remoteRecordedBackend();
    if (opts.to === "remote" && recorded === "gcs") {
      return {
        ok: false,
        error: `Another machine just finished migrating this install into gs://${remoteRecord.bucket}; the local state here is out of date. Nothing else was changed. Use: ${selfCommand("attach", "--project", projectId)}`,
      };
    }
    if (opts.to === "local" && recorded !== "gcs") {
      return {
        ok: false,
        error: `gs://${remoteRecord.bucket}/install/install.json no longer names the bucket as this install's state (another machine moved it back to itself). Nothing else was changed; manage the install from that machine.`,
      };
    }
    return await finish();
  } finally {
    await release().catch((e: unknown) => report.warn(errorText(e)));
  }

  async function finish(): Promise<MigrateResult> {
    // --- 3. Target -----------------------------------------------------------
    const tg = report.step(
      opts.to === "remote" ? "Preparing the bucket target" : "Preparing the local state dir",
    );
    let to: ResolvedBackend;
    try {
      if (opts.to === "local" && !deps.localStateEmpty()) {
        // install.json names the bucket, so a stack here is not in use: the
        // leftover of an interrupted `--to local`. Kept, never deleted.
        const moved = deps.retireLocalState();
        report.info(`Moved an unused local stack (interrupted migration?) aside to ${moved}`);
      }
      if (opts.to === "local") deps.prepareLocalTarget();
      to = deps.resolve(targetRecord);
      // A remote stack here is not authoritative (checked in the preflight:
      // the bucket's install.json doesn't name it), so it is the leftover of
      // an interrupted migration or of an earlier `--to local`.
      if (await pulumi.stackExists(to)) {
        report.info(
          `Replacing an unused copy in ${to.url} (left by an earlier or interrupted migration)`,
        );
        await pulumi.removeStack(to);
      }
      tg.done(`Target ready: ${to.url}`);
    } catch (e) {
      tg.failed("Could not prepare the target");
      return { ok: false, error: `${errorText(e)}. The source is unchanged and still in use.` };
    }

    // --- 4 + 5. Copy and verify ----------------------------------------------
    const cp = report.step(`Copying the stack to ${to.url} and verifying it`);
    const abandon = async (why: string): Promise<MigrateResult> => {
      cp.failed(why);
      try {
        await pulumi.removeStack(to);
      } catch (e) {
        report.warn(`Could not remove the partial copy in ${to.url}: ${errorText(e)}`);
      }
      return {
        ok: false,
        error: `${why}. The copy was discarded; install.json still names ${from.url}, which stays authoritative.`,
      };
    };
    try {
      if (mode === "stack-migrate") await pulumi.stackMigrate(from, to);
      else await pulumi.exportImport(from, to);
    } catch (e) {
      return abandon(`Copy failed: ${errorText(e)}`);
    }
    try {
      const changes = await pulumi.previewChanges(to);
      if (changes > 0)
        return abandon(`Verification failed: a preview of the copy shows ${changes} change(s)`);
      if ((await pulumi.outputsDigest(to)) !== sourceDigest) {
        return abandon("Verification failed: the copy's outputs differ from the source's");
      }
      // An installer run elsewhere may have updated the source since the
      // preflight (only migrations take the lock): the copy would then miss
      // that update. Checked last, right before the switch.
      if ((await pulumi.stateDigest(from)) !== sourceState) {
        return abandon(
          "The source stack changed during the migration (another run updated it); migrate again once it is idle",
        );
      }
    } catch (e) {
      return abandon(`Verification failed: ${errorText(e)}`);
    }
    cp.done("Copied; preview shows no changes and the outputs match");

    // --- 6. Flip ---------------------------------------------------------------
    const fl = report.step("Recording the new backend in install.json");
    try {
      deps.adopt(targetRecord);
    } catch (e) {
      fl.failed("Could not record the new backend");
      return {
        ok: false,
        error: `${errorText(e)}. The copy in ${to.url} is complete, but install.json still names ${from.url}; re-run state migrate to finish.`,
      };
    }
    fl.done(`install.json: stateBackend=${targetRecord.kind}`);
    if (opts.to === "remote") {
      const moved = deps.retireLocalState();
      if (moved)
        report.info(
          `Old local state kept at ${moved} (not used any more; delete it once you are confident)`,
        );
      report.success(
        `Done. Pulumi state + install metadata now live in gs://${remoteRecord.bucket}; secrets are encrypted with Cloud KMS. Other machines: ${selfCommand("attach", "--project", projectId)}`,
      );
    } else {
      report.success(
        `Done. Pulumi state is back in ~/.caelo-${meta.installId}/state (passphrase in secrets/). The copy in gs://${remoteRecord.bucket}/pulumi is no longer used; the bucket's install.json now says so.`,
      );
    }
    return { ok: true, changed: true };
  }
}
