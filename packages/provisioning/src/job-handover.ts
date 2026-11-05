// SPDX-License-Identifier: MPL-2.0

/**
 * How an update job hands its request to the ops image of the release it
 * installs (#819 for the converge job, #1029 for the upgrader). Both jobs
 * have the same two stages, told apart by comparing the release their code
 * belongs to with the request's:
 *
 *   Stage 1 — the job runs the INSTALLED release's image. After its own
 *     gate it verifies the target's ops image, points itself at it BY
 *     DIGEST (only the image changes: identity, command and args stay) and
 *     starts a new execution, which takes the request over.
 *   Stage 2 — the job runs the TARGET's image and does the work.
 *
 * The point of the split: a fix to the logic that decides and installs
 * reaches every install with the release that carries it. Without stage 1
 * that logic always comes from the release being replaced.
 *
 * This file holds that sequence once, for both jobs, because its order is
 * what keeps it safe: the signature before the image moves, the image moved
 * under the state lock, the request released before the next run exists.
 */

import type { ExecutionState } from "./install-job.js";
import { compareSemver, type ReleaseManifest } from "./release-manifest.js";
import type { ClaimedUpdate, UpdateEndStatus, UpgraderRunResult } from "./upgrader-job.js";
import type { EventReporter, JobLog } from "./upgrader-reporter.js";

/** What a job's claim found. */
export interface JobClaim {
  readonly request: ClaimedUpdate;
  /**
   * The request was already running: stage 1 handed it to this run, or a
   * run that died left it. Fresh claims (pending → running) are false.
   */
  readonly resume: boolean;
  /** The execution the request names now (after a fresh claim: this one). */
  readonly execution: string | null;
}

/** The part of a job's queue that moves a running request between runs. */
export interface HandoverQueue {
  /**
   * Point running request `requestId` at execution `to` — or at none
   * (`null`: released for the next run to adopt) — only while it still
   * names `from`. Resolves false when another run got there first.
   */
  handover(requestId: string, from: string | null, to: string | null): Promise<boolean>;
}

/** What a job does to itself and asks about itself to hand over. */
export interface SelfHandoverDeps {
  /** This Cloud Run execution; null outside Cloud Run. */
  readonly execution: string | null;
  /** The Caelo release this code belongs to (CAELO_VERSION of the image). */
  readonly ownVersion: string;
  /** Verify the cosign signature of the release image `slug@digest`. */
  readonly verifyImage: (slug: "ops", digest: string) => Promise<boolean>;
  /** The digest of the image this execution runs (from Cloud Run); null when unreadable. */
  readonly ownImageDigest: () => Promise<string | null>;
  /** Point this job at the ops image with `digest` (its identity, command and args stay). */
  readonly pointJobAt: (
    digest: string,
  ) => Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }>;
  /** Start a new execution of this job; returns its name. */
  readonly startJob: () => Promise<
    | { readonly ok: true; readonly execution: string }
    | { readonly ok: false; readonly error: string }
  >;
  /** Where an execution of this job stands (Cloud Run). */
  readonly executionState: (execution: string) => Promise<ExecutionState>;
}

/** How a request ends because the run cannot go on. */
export interface HandoverBlocked {
  readonly status: UpdateEndStatus;
  readonly codes: readonly string[];
  readonly reason: string;
}

/** Whether this run is the one to work on the request. */
export type Adoption =
  | {
      readonly kind: "work";
      /** This run took a request another run started, or one no run names. */
      readonly adopted: boolean;
    }
  /**
   * This run ends without touching the request. `failed`: it could not tell
   * whether another run has it, so the job's run reports an error.
   */
  | { readonly kind: "leave"; readonly message: string; readonly failed?: boolean };

/**
 * Decide whether this run may work on `claim`, adopting the request when
 * another run started it: only once that run has ended, because two runs
 * at once must never happen. An error here never ends the request: nothing
 * yet says this run owns it, and the run that does may be alive.
 */
export async function adoptClaim(
  claim: JobClaim,
  deps: Pick<SelfHandoverDeps, "execution" | "executionState"> & {
    readonly queue: HandoverQueue;
  },
): Promise<Adoption> {
  if (!claim.resume || (deps.execution !== null && claim.execution === deps.execution)) {
    return { kind: "work", adopted: false };
  }
  if (!deps.execution) {
    return {
      kind: "leave",
      message: "an update request is running; only a Cloud Run execution may adopt it",
    };
  }
  try {
    if (claim.execution) {
      const live = await deps.executionState(claim.execution);
      if (live === "running") {
        return {
          kind: "leave",
          message: `execution ${claim.execution} is still installing; this run does nothing`,
        };
      }
    }
    if (!(await deps.queue.handover(claim.request.id, claim.execution, deps.execution))) {
      return {
        kind: "leave",
        message: "another run adopted the request first; this run does nothing",
      };
    }
  } catch (e) {
    return {
      kind: "leave",
      failed: true,
      message: `could not tell whether run ${claim.execution ?? "(none)"} still has the request, so this run leaves it alone: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  return { kind: "work", adopted: true };
}

/** Whether this code belongs to another release than the request's: stage 1. */
export function isStageOne(ownVersion: string, targetVersion: string): boolean {
  return compareSemver(ownVersion, targetVersion) !== 0;
}

/**
 * Every digest the ops image the manifest signs is known by. Cloud Run
 * records the linux/amd64 platform manifest it resolved, not the index the
 * hand-over pinned (#1025), so an execution of the right image reads back
 * as the platform form the manifest also signs.
 */
export function signedOpsDigests(m: ReleaseManifest): readonly string[] {
  return [m.digests.ops, ...(m.platformDigests ? [m.platformDigests.ops] : [])];
}

/**
 * Stage 2's check that the image this run executes is the one the manifest
 * signs. Null when it is; how the request ends otherwise.
 *
 * @param own the digest Cloud Run names for this execution, null when unreadable
 * @param noun what the timeline calls this job's image
 */
export function ownImageProblem(
  m: ReleaseManifest,
  own: string | null,
  noun: string,
): HandoverBlocked | null {
  const signed = signedOpsDigests(m);
  if (own !== null && signed.includes(own)) return null;
  return {
    status: "refused",
    codes: ["ops-image"],
    reason: `Nothing was changed: this run's ${noun} image (${own ?? "unknown"}) is not the one Caelo's release workflow signed for ${m.version} (${signed.join(" or ")}). Start the update again from Settings → Updates.`,
  };
}

/** What {@link handOverToRelease} works with: the job's closures over its run. */
export interface HandoverContext {
  readonly deps: SelfHandoverDeps;
  readonly queue: HandoverQueue;
  readonly requestId: string;
  /** What the timeline calls this job's image: `installer`, `upgrader`. */
  readonly noun: string;
  readonly reporter: EventReporter;
  readonly log: JobLog;
  /** Take the install's state lock; how the request ends when it cannot be had. */
  readonly lock: () => HandoverBlocked | null;
  readonly unlock: () => void;
  readonly stop: (blocked: HandoverBlocked) => Promise<UpgraderRunResult>;
  readonly leave: (message: string) => UpgraderRunResult;
}

/**
 * Stage 1: hand the request to the target release's own signed ops image.
 * `m` is a manifest whose signature verified and that the job's gate let
 * through; nothing else about the install changes here.
 */
export async function handOverToRelease(
  m: ReleaseManifest,
  c: HandoverContext,
): Promise<UpgraderRunResult> {
  const { deps, noun, reporter: r } = c;
  if (!(await deps.verifyImage("ops", m.digests.ops))) {
    return c.stop({
      status: "refused",
      codes: ["signature"],
      reason: `The ${noun} image of ${m.version} is not signed by Caelo's release workflow, so nothing was changed.`,
    });
  }
  // The target's image naming another version would hand over to itself
  // for ever: each run would start the next. Only a broken build gets here.
  const own = await deps.ownImageDigest();
  if (own !== null && signedOpsDigests(m).includes(own)) {
    return c.stop({
      status: "refused",
      codes: ["ops-image"],
      reason: `Nothing was changed: this run already is the ${noun} image Caelo's release workflow signed for ${m.version}, but it reports version ${deps.ownVersion}. That release's image is broken; a newer release installs normally.`,
    });
  }
  // Under the lock (the terminal `upgrade` redeploys this job too), and
  // released before the new run starts: it takes the lock itself.
  const locked = c.lock();
  if (locked) return c.stop(locked);
  let pointed: Awaited<ReturnType<SelfHandoverDeps["pointJobAt"]>>;
  try {
    pointed = await deps.pointJobAt(m.digests.ops);
  } finally {
    c.unlock();
  }
  if (!pointed.ok) {
    return c.stop({
      status: "failed",
      codes: ["handover"],
      reason: `Nothing was changed: the ${noun} of ${m.version} could not be prepared (${pointed.error}). Try again in a moment.`,
    });
  }
  // Release the request BEFORE the new run exists: it adopts a request
  // that names no run at once, while a run still named (this one, alive
  // for a moment longer) would make it step back.
  if (!(await c.queue.handover(c.requestId, deps.execution, null))) {
    return c.leave("the request moved on before the hand-over; this run does nothing");
  }
  const started = await deps.startJob();
  if (!started.ok) {
    return c.stop({
      status: "failed",
      codes: ["handover"],
      reason: `Nothing on the site was changed: the ${noun} of ${m.version} is ready but could not be started (${started.error}). Try again in a moment.`,
    });
  }
  r.info(`The ${noun} of ${m.version} runs now (run ${started.execution}).`);
  await r.flush();
  c.log({
    severity: "INFO",
    message: `handed over to ${started.execution}`,
    requestId: c.requestId,
  });
  return { exitCode: 0, requestId: c.requestId, status: null };
}
