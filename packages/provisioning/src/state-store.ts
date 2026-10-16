// SPDX-License-Identifier: MPL-2.0

/**
 * Where install.json and progress.json are read from and written to (#696).
 *
 *   - {@link LocalStateStore}: `~/.caelo-<id>/` — every install before #696,
 *     and self-hosted always.
 *   - {@link GcsStateStore}: the install's ops bucket
 *     (`gs://<project>-caelo-ops/install/`), which is authoritative. A local
 *     copy is kept in `~/.caelo-<id>/` so `listInstalls` and the install
 *     picker work offline, but every read in a process starts from the
 *     bucket and every write goes to the bucket first.
 *
 * Both stores refuse to write secret material (checkpoint-secrets.ts, #656 /
 * #659): install.json and progress.json are read by tooling, backups and
 * agents, and a bucket copy is no place for a database password either. The
 * guard sits inside each store's `write`, so no caller can skip it.
 *
 * The interface is synchronous on purpose: install-state.ts's callers (the
 * wizard steps, `markStepDone`, the lifecycle commands) are synchronous, and
 * the bucket store shells out to `gcloud storage` synchronously.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { assertNoCheckpointSecrets, assertNoSecrets } from "./checkpoint-secrets.js";
import { type GcloudResult, gcloudEnv } from "./gcloud.js";
import { OPS_INSTALL_PREFIX } from "./state-backend.js";

/** The two documents a store holds. */
export type StateFile = "install.json" | "progress.json";

/** Reads and writes an install's metadata documents. */
export interface StateStore {
  readonly kind: "local" | "gcs";
  /** The document's text, or null when it does not exist. */
  read(file: StateFile): string | null;
  /** Replace the document. Refuses secret material. */
  write(file: StateFile, value: unknown): void;
}

/** A synchronous gcloud invocation; `input` is fed on stdin. Tests pass a fake. */
export type SyncGcloud = (args: string[], input?: string) => GcloudResult;

/** The real {@link SyncGcloud}: `gcloud` with prompts disabled. */
export const realSyncGcloud: SyncGcloud = (args, input) => {
  const r = spawnSync("gcloud", args, {
    env: gcloudEnv(),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...(input !== undefined ? { input } : { stdio: ["ignore", "pipe", "pipe"] }),
  });
  if (r.error) throw r.error;
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    exitCode: r.status ?? 1,
  };
};

/**
 * Serialize a document after the checkpoint-secrets guard. install.json is
 * checked for any secret; progress.json with the checkpoint rules (step
 * payloads, outputs).
 */
export function serializeGuarded(file: StateFile, value: unknown): string {
  if (file === "install.json") assertNoSecrets(value, file);
  else assertNoCheckpointSecrets(value, file);
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Atomic mode-0600 write (temp file + rename in the same directory). */
function writeTextAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** install.json + progress.json in `~/.caelo-<id>/`. */
export class LocalStateStore implements StateStore {
  readonly kind = "local" as const;
  constructor(private readonly root: string) {}

  read(file: StateFile): string | null {
    const path = join(this.root, file);
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  }

  write(file: StateFile, value: unknown): void {
    writeTextAtomic(join(this.root, file), serializeGuarded(file, value));
  }
}

/** gcloud's wording for an object that is not there. */
const NOT_FOUND = /matched no objects|No URLs matched|NotFound|404|does not exist/i;

/**
 * install.json + progress.json in the ops bucket, mirrored to
 * `~/.caelo-<id>/`. The first read of a document in a process fetches it
 * from the bucket; later reads use the in-memory copy, which every write
 * updates. A bucket error throws — the bucket is the source of truth, so
 * silently using the local mirror could resume from a stale checkpoint.
 */
export class GcsStateStore implements StateStore {
  readonly kind = "gcs" as const;
  private readonly cache = new Map<StateFile, string | null>();

  constructor(
    private readonly bucket: string,
    private readonly root: string,
    private readonly run: SyncGcloud = realSyncGcloud,
  ) {}

  /** `gs://<bucket>/install/<file>`. */
  objectUrl(file: StateFile): string {
    return `gs://${this.bucket}/${OPS_INSTALL_PREFIX}/${file}`;
  }

  /**
   * The document as the bucket holds it right now, without caching it or
   * touching the local mirror — for looking at a bucket this machine may
   * not own (the wizard's "is this project already an install?" check).
   */
  peek(file: StateFile): string | null {
    const r = this.run(["storage", "cat", this.objectUrl(file)]);
    if (r.ok) return r.stdout;
    if (NOT_FOUND.test(r.stderr)) return null;
    throw new Error(
      `Could not read ${this.objectUrl(file)}: ${r.stderr.trim() || `gcloud exited ${r.exitCode}`}. Check that you are signed in (gcloud auth login) as an account with access to the install's ops bucket.`,
    );
  }

  read(file: StateFile): string | null {
    if (this.cache.has(file)) return this.cache.get(file) ?? null;
    const text = this.peek(file);
    this.cache.set(file, text);
    if (text !== null) writeTextAtomic(join(this.root, file), text);
    return text;
  }

  write(file: StateFile, value: unknown): void {
    const text = serializeGuarded(file, value);
    const r = this.run(
      ["storage", "cp", "-", this.objectUrl(file), "--content-type=application/json"],
      text,
    );
    if (!r.ok) {
      throw new Error(
        `Could not write ${this.objectUrl(file)}: ${r.stderr.trim() || `gcloud exited ${r.exitCode}`}. Nothing was changed locally; fix access to the ops bucket and re-run.`,
      );
    }
    this.cache.set(file, text);
    writeTextAtomic(join(this.root, file), text);
  }
}

/**
 * Another run holds the install's state lock. Distinct from every other
 * lock failure (no access, gcloud missing), which callers must not report
 * as "busy" — retrying later will not fix those.
 */
export class StateLockHeldError extends Error {
  override readonly name = "StateLockHeldError";
}

/** `gs://<bucket>/install/state.lock` — see {@link acquireBucketStateLock}. */
export function bucketStateLockUrl(bucket: string): string {
  return `gs://${bucket}/${OPS_INSTALL_PREFIX}/state.lock`;
}

/** Who holds a lock, for the refusal message. */
function lockBody(purpose: string): string {
  return JSON.stringify({
    purpose,
    host: hostname(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });
}

/**
 * The install's state lock in its ops bucket, created only if absent
 * (`--if-generation-match=0`). Held by every writer of a bucket-backed
 * install's state — an installer run's `pulumi up`, `state migrate` — so
 * none writes a backend another is switching away from. A lock left by a
 * crashed run is reported with the command to remove it, never broken
 * automatically.
 *
 * @returns the release function
 */
export function acquireBucketStateLock(
  bucket: string,
  purpose: string,
  run: SyncGcloud = realSyncGcloud,
): () => void {
  const url = bucketStateLockUrl(bucket);
  const r = run(["storage", "cp", "-", url, "--if-generation-match=0"], lockBody(purpose));
  if (!r.ok) {
    if (/PreconditionFailed|412|At least one of the pre-conditions/i.test(r.stderr)) {
      const held = run(["storage", "cat", url]);
      throw new StateLockHeldError(
        `Another run is changing this install's state (${held.ok ? held.stdout.trim() : url}). Re-run once it has finished; if none is running, remove the stale lock: gcloud storage rm ${url}`,
      );
    }
    throw new Error(`Could not take the state lock ${url}: ${r.stderr.trim()}`);
  }
  return () => {
    const rm = run(["storage", "rm", url]);
    if (!rm.ok) throw new Error(`Could not release ${url}; remove it: gcloud storage rm ${url}`);
  };
}

/**
 * The same lock for an install whose state is on this machine:
 * `~/.caelo-<id>/state.lock`, created exclusively.
 *
 * @returns the release function
 */
export function acquireLocalStateLock(root: string, purpose: string): () => void {
  const path = join(root, "state.lock");
  try {
    writeFileSync(path, lockBody(purpose), { flag: "wx", mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      throw new StateLockHeldError(
        `Another run is changing this install's state (${readFileSync(path, "utf8").trim()}). Re-run once it has finished; if none is running, remove the stale lock: rm ${path}`,
      );
    }
    throw e;
  }
  return () => rmSync(path, { force: true });
}

/** The state lock for whichever backend `bucket` (gcs) or `root` (local) names. */
export function acquireStateLock(
  backend: { readonly kind: "local" } | { readonly kind: "gcs"; readonly bucket: string },
  root: string,
  purpose: string,
  run: SyncGcloud = realSyncGcloud,
): () => void {
  return backend.kind === "gcs"
    ? acquireBucketStateLock(backend.bucket, purpose, run)
    : acquireLocalStateLock(root, purpose);
}
