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
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertNoCheckpointSecrets, assertNoSecrets } from "./checkpoint-secrets.js";
import { type GcloudResult, gcloudEnv } from "./gcloud.js";
import { OPS_INSTALL_PREFIX } from "./state-backend.js";
import {
  describeExecutionArgs,
  type ExecutionLockHolder,
  judgeHeldLock,
  type LocalHost,
  type LockHolder,
  lockBody,
  PROCESS_LEASE_MS,
  parseExecutionState,
  parseLockBody,
  renewedLockBody,
} from "./state-lock-lease.js";

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

/** gcloud's wording for a failed `--if-generation-match` precondition. */
const PRECONDITION_FAILED = /PreconditionFailed|412|At least one of the pre-conditions/i;

/** How a bucket lock is taken: who holds it, and the clock to judge leases by. */
export interface BucketLockOptions {
  /**
   * The Cloud Run execution taking the lock (#815): the lock's lease is the
   * execution's task timeout, and a later run may break it once Cloud Run
   * says this execution has finished. Without it the holder is this
   * process (a CLI run): the lock names host + pid, carries a lease of
   * {@link PROCESS_LEASE_MS} and is renewed by a heartbeat until released.
   */
  readonly holder?: ExecutionLockHolder;
  /** Told when a dead holder's lock was broken, with why. */
  readonly onBreak?: (message: string) => void;
  /**
   * Told when the heartbeat found the lock no longer this run's (another
   * run broke it after the lease ran out, e.g. while this machine slept).
   */
  readonly onLost?: (message: string) => void;
  readonly now?: () => Date;
  /** Starts the heartbeat; returns its stop. Defaults to an unref'd setInterval. */
  readonly schedule?: (tick: () => void, everyMs: number) => () => void;
  /** This host and its pid check (state-lock-lease.ts LocalHost); tests pass a fake. */
  readonly here?: LocalHost;
}

const defaultSchedule = (tick: () => void, everyMs: number): (() => void) => {
  const timer = setInterval(tick, everyMs);
  // The heartbeat must never keep a finished CLI alive.
  timer.unref?.();
  return () => clearInterval(timer);
};

/**
 * The install's state lock in its ops bucket, created only if absent
 * (`--if-generation-match=0`). Held by every writer of a bucket-backed
 * install's state — an installer run's `pulumi up`, `state migrate`, the
 * CLI `upgrade`, the upgrader job — so none writes a backend another is
 * switching away from.
 *
 * A lock that is held is judged (state-lock-lease.ts): one whose Cloud Run
 * execution has finished, whose execution is gone after its lease, whose
 * CLI process is gone on this host, or whose CLI lease ran out unrenewed,
 * is broken with a generation-matched delete and taken once more. The
 * generation is read BEFORE the body, so the delete can only remove the
 * lock that was judged: if another run replaced it in between, the
 * delete's precondition fails and nothing is removed. Two runs breaking the
 * same dead lock cannot both win either — the slower one's create fails
 * its own precondition and reports the lock as held.
 *
 * A CLI holder renews its lease every third of {@link PROCESS_LEASE_MS}
 * with a generation-matched rewrite, so a run that is alive keeps its lock
 * however long it takes, and a killed one loses it within one lease.
 *
 * @returns the release function; it stops the heartbeat and deletes only
 *   this lock's generation
 * @throws StateLockHeldError when another run holds the lock
 * @throws Error when the lock or its holder cannot be read (no access)
 */
export function acquireBucketStateLock(
  bucket: string,
  purpose: string,
  run: SyncGcloud = realSyncGcloud,
  opts: BucketLockOptions = {},
): () => void {
  const url = bucketStateLockUrl(bucket);
  const now = opts.now ?? (() => new Date());
  const holder: LockHolder = opts.holder ?? { leaseMs: PROCESS_LEASE_MS };
  const id = randomUUID();
  const create = () =>
    run(
      ["storage", "cp", "-", url, "--if-generation-match=0"],
      lockBody(purpose, now(), holder, id),
    );
  let r = create();
  if (!r.ok && PRECONDITION_FAILED.test(r.stderr)) {
    breakDeadLock(url, run, now(), opts.onBreak, opts.here);
    r = create();
    if (!r.ok && PRECONDITION_FAILED.test(r.stderr)) {
      throw new StateLockHeldError(
        `Another run took this install's state lock at the same moment (${readLockText(url, run)}). Re-run once it has finished.`,
      );
    }
  }
  if (!r.ok) throw new Error(`Could not take the state lock ${url}: ${r.stderr.trim()}`);
  const owned = ownedGeneration(url, run, id);
  if (owned.kind !== "owned") {
    // Ours, just created — but without its generation a delete could hit a
    // successor's lock. Give it back only once a second look proves it is
    // still ours at a known generation; otherwise its lease ends it.
    const retry = ownedGeneration(url, run, id);
    if (retry.kind === "owned") {
      run(["storage", "rm", url, `--if-generation-match=${retry.generation}`]);
    }
    throw new Error(
      `Could not read the generation of the state lock ${url} this run just took (${owned.why}). ${
        retry.kind === "owned"
          ? "It was given back."
          : "It was left in place and expires with its lease; re-run after that."
      }`,
    );
  }
  let generation = owned.generation;
  let lost: string | null = null;
  const stopHeartbeat =
    "execution" in holder
      ? () => {}
      : (opts.schedule ?? defaultSchedule)(
          () => {
            if (lost !== null) return;
            const renewed = renewLock(url, run, id, generation, now(), holder.leaseMs);
            if (renewed.kind === "owned") {
              generation = renewed.generation;
              return;
            }
            if (renewed.kind === "lost") {
              lost = renewed.why;
              opts.onLost?.(
                `This run no longer holds the install's state lock (${renewed.why}). Stop it and re-run once the other run has finished.`,
              );
            }
            // "error": a transient failure; the next beat tries again within the lease.
          },
          Math.floor(holder.leaseMs / 3),
        );
  return () => {
    stopHeartbeat();
    const rm = run(["storage", "rm", url, `--if-generation-match=${generation}`]);
    if (rm.ok) return;
    if (PRECONDITION_FAILED.test(rm.stderr) || NOT_FOUND.test(rm.stderr)) {
      throw new Error(
        `The state lock ${url} was no longer this run's when it finished (another run broke it); it was left alone.`,
      );
    }
    throw new Error(`Could not release ${url}; remove it: gcloud storage rm ${url}`);
  };
}

type Ownership =
  | { readonly kind: "owned"; readonly generation: string }
  | { readonly kind: "lost"; readonly why: string }
  | { readonly kind: "error"; readonly why: string };

/**
 * The lock's generation, provided the lock is still the one with `id`. The
 * generation is read before the body: if another run replaced the lock in
 * between, the body names its id and this returns "lost" — never a
 * generation that is not ours.
 */
function ownedGeneration(url: string, run: SyncGcloud, id: string): Ownership {
  const g = lockGeneration(url, run);
  if (g.kind === "absent") return { kind: "lost", why: "the lock is gone" };
  if (g.kind === "error") return { kind: "error", why: g.error };
  const body = run(["storage", "cat", url]);
  if (!body.ok) {
    return NOT_FOUND.test(body.stderr)
      ? { kind: "lost", why: "the lock is gone" }
      : { kind: "error", why: body.stderr.trim() || `gcloud exited ${body.exitCode}` };
  }
  const parsed = parseLockBody(body.stdout);
  if (parsed?.id !== id) {
    return { kind: "lost", why: `another run holds it now (${body.stdout.trim().slice(0, 200)})` };
  }
  return { kind: "owned", generation: g.generation };
}

/**
 * One heartbeat: rewrite the lock with a later lease, only if it is still
 * at `generation` (ours), and return its new generation.
 */
function renewLock(
  url: string,
  run: SyncGcloud,
  id: string,
  generation: string,
  now: Date,
  leaseMs: number,
): Ownership {
  const current = run(["storage", "cat", url]);
  if (!current.ok) {
    return NOT_FOUND.test(current.stderr)
      ? { kind: "lost", why: "the lock is gone" }
      : { kind: "error", why: current.stderr.trim() };
  }
  const body = parseLockBody(current.stdout);
  if (body?.id !== id) {
    return {
      kind: "lost",
      why: `another run holds it now (${current.stdout.trim().slice(0, 200)})`,
    };
  }
  const w = run(
    ["storage", "cp", "-", url, `--if-generation-match=${generation}`],
    renewedLockBody(body, now, leaseMs),
  );
  if (!w.ok) {
    return PRECONDITION_FAILED.test(w.stderr)
      ? { kind: "lost", why: "another run replaced it" }
      : { kind: "error", why: w.stderr.trim() };
  }
  return ownedGeneration(url, run, id);
}

type LockGeneration =
  | { readonly kind: "found"; readonly generation: string }
  | { readonly kind: "absent" }
  | { readonly kind: "error"; readonly error: string };

/** The lock object's current generation. */
function lockGeneration(url: string, run: SyncGcloud): LockGeneration {
  const d = run(["storage", "objects", "describe", url, "--format=json"]);
  if (!d.ok) {
    return NOT_FOUND.test(d.stderr)
      ? { kind: "absent" }
      : { kind: "error", error: d.stderr.trim() || `gcloud exited ${d.exitCode}` };
  }
  try {
    const g = (JSON.parse(d.stdout) as { generation?: unknown }).generation;
    if (typeof g === "string" || typeof g === "number") {
      return { kind: "found", generation: String(g) };
    }
  } catch {
    // Reported below with the same message as a missing field.
  }
  return { kind: "error", error: "gcloud described the lock without a generation" };
}

function readLockText(url: string, run: SyncGcloud): string {
  const held = run(["storage", "cat", url]);
  return held.ok ? held.stdout.trim() : url;
}

/**
 * Judge the held lock at `url` and break it when its holder is dead.
 * Returns normally when the lock was broken or vanished meanwhile, so the
 * caller creates it once more; throws when it is live or cannot be judged.
 */
function breakDeadLock(
  url: string,
  run: SyncGcloud,
  now: Date,
  onBreak: ((message: string) => void) | undefined,
  here: LocalHost | undefined,
): void {
  const found = lockGeneration(url, run);
  if (found.kind === "absent") return;
  if (found.kind === "error") {
    throw new Error(`Could not read the state lock ${url} another run holds: ${found.error}`);
  }
  const held = run(["storage", "cat", url]);
  if (!held.ok) {
    if (NOT_FOUND.test(held.stderr)) return;
    throw new Error(`Could not read the state lock ${url}: ${held.stderr.trim()}`);
  }
  const verdict = judgeHeldLock(
    held.stdout,
    (ref) => parseExecutionState(run(describeExecutionArgs(ref))),
    now,
    here,
  );
  if (verdict.kind === "unknown") {
    // Not contention: retrying will not help, and guessing "dead" could let
    // two runs write the same state.
    throw new Error(`The state lock ${url} is held and ${verdict.why}`);
  }
  if (verdict.kind === "held") {
    throw new StateLockHeldError(
      verdict.manualRemoval
        ? `Another run is changing this install's state (${verdict.why}). Re-run once it has finished; if none is running, remove the stale lock: gcloud storage rm ${url}`
        : `Another run is changing this install's state: ${verdict.why}. Re-run once it has finished.`,
    );
  }
  const rm = run(["storage", "rm", url, `--if-generation-match=${found.generation}`]);
  if (!rm.ok && !NOT_FOUND.test(rm.stderr)) {
    if (PRECONDITION_FAILED.test(rm.stderr)) {
      throw new StateLockHeldError(
        `Another run took this install's state lock while this one removed a stale one (${readLockText(url, run)}). Re-run once it has finished.`,
      );
    }
    throw new Error(`Could not remove the stale state lock ${url}: ${rm.stderr.trim()}`);
  }
  onBreak?.(`Removed a stale state lock: ${verdict.why}.`);
}

/**
 * The same lock for an install whose state is on this machine:
 * `~/.caelo-<id>/state.lock`, created exclusively. A lock left by a
 * process that is gone on this machine is taken over (#815).
 *
 * @param here this host and its pid check; tests pass a fake
 * @returns the release function
 */
export function acquireLocalStateLock(root: string, purpose: string, here?: LocalHost): () => void {
  const path = join(root, "state.lock");
  const take = () =>
    writeFileSync(path, lockBody(purpose, new Date()), { flag: "wx", mode: 0o600 });
  try {
    try {
      take();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // #815 — the file is on this machine, so a holder whose process has
      // ended is known dead: take its lock over instead of asking for `rm`.
      const verdict = judgeHeldLock(
        readFileSync(path, "utf8"),
        () => ({ kind: "unknown", error: "a machine-local lock names no Cloud Run execution" }),
        new Date(),
        here,
      );
      if (verdict.kind !== "break") throw e;
      rmSync(path, { force: true });
      take();
    }
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
  opts: BucketLockOptions = {},
): () => void {
  return backend.kind === "gcs"
    ? acquireBucketStateLock(backend.bucket, purpose, run, opts)
    : acquireLocalStateLock(root, purpose, opts.here);
}

/** The part of `process` {@link releaseOnSignal} needs; tests pass a fake. */
export interface SignalTarget {
  once(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  exit(code: number): never;
}

/**
 * Give the state lock back when the CLI is stopped (Ctrl-C, a closed Cloud
 * Shell tab's SIGTERM), then exit with the signal's conventional code
 * (#815). Without this a stopped run leaves its lock until its lease ends.
 *
 * @param report told what happened to the lock
 * @returns removes the handlers; call it once the run released the lock itself
 */
export function releaseOnSignal(
  release: () => void,
  report: (message: string) => void,
  proc: SignalTarget = process,
): () => void {
  const dispose = () => {
    proc.removeListener("SIGINT", onInt);
    proc.removeListener("SIGTERM", onTerm);
  };
  const stop = (signal: "SIGINT" | "SIGTERM", code: number): never => {
    dispose();
    try {
      release();
      report(`Stopped (${signal}); the install's state lock was released.`);
    } catch (e) {
      report(`Stopped (${signal}); ${e instanceof Error ? e.message : String(e)}`);
    }
    return proc.exit(code);
  };
  const onInt = () => stop("SIGINT", 130);
  const onTerm = () => stop("SIGTERM", 143);
  proc.once("SIGINT", onInt);
  proc.once("SIGTERM", onTerm);
  return dispose;
}
