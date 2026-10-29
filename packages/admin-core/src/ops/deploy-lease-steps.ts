// SPDX-License-Identifier: MPL-2.0

/**
 * The lease steps a deploy run that holds no transaction runs between its
 * own steps (#1211 Stage, #1225 Publish live, #1220 plugin-data build):
 * acquire a publish lease, waiting outside any transaction, and prove — right
 * before an irreversible provider step — that the run still holds every
 * lease it needs. Each step is one short op through the run's registry.
 */

import { execute, type OperationSteps } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { describeError } from "../ai/tools/_describe-error.js";
import type { DeployRunBeat } from "../deploy/deploy-run-lock.js";
import { abortMessage } from "../deploy/generator-subprocess.js";

/** Sleep that ends early (false) when `signal` aborts. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((done) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      done(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      done(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** What acquiring a lease answered. */
export type LeaseAcquisition<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      /** Why it stopped; the caller records it (deploy.fail_run). */
      readonly message: string;
      /** True when the wait ran out (not a failure or a stop). */
      readonly busy: boolean;
    };

/**
 * Take a lease for `runId` through `op` (deploy.acquire_staging_publication
 * or deploy.acquire_live_release), polling outside any transaction while
 * someone else holds it, for at most `waitMs` (0: try once).
 *
 * @param args.busyMessage - the refusal once the wait ran out, given the
 *   holding run (null: a transaction or the previous release holds it).
 */
export async function acquireLeaseStep<T extends { acquired: boolean; heldByRunId: string | null }>(
  steps: OperationSteps,
  sys: ExecutionContext,
  args: {
    readonly op: "deploy.acquire_staging_publication" | "deploy.acquire_live_release";
    readonly runId: string;
    readonly ttlMs: number;
    readonly stop: AbortSignal;
    readonly waitMs: number;
    readonly what: string;
    readonly busyMessage: (heldByRunId: string | null) => string;
  },
): Promise<LeaseAcquisition<T>> {
  const deadline = Date.now() + args.waitMs;
  let pause = 100;
  for (;;) {
    if (args.stop.aborted) return { ok: false, message: abortMessage(args.stop), busy: false };
    const r = await execute(steps.registry, steps.adapter, sys, args.op, {
      runId: args.runId,
      ttlMs: args.ttlMs,
    });
    if (!r.ok) {
      return {
        ok: false,
        message: `could not take the ${args.what}: ${describeError(r.error)}. Nothing was published.`,
        busy: false,
      };
    }
    const v = r.value as T;
    if (v.acquired) return { ok: true, value: v };
    if (Date.now() >= deadline) {
      return { ok: false, message: args.busyMessage(v.heldByRunId), busy: true };
    }
    await abortableSleep(pause, args.stop);
    pause = Math.min(pause * 2, 2_000);
  }
}

/**
 * Prove that `runId` still holds its run lease and every publish lease in
 * `need`, renewing them all. The leases then hold until at least a TTL
 * after this call started; the returned `until` is half of that window, the
 * rest is the margin for a provider step already in flight.
 *
 * @param args.lostMessage - the refusal when a lease lapsed or the run was
 *   swept, or when the renewal itself failed (with its error).
 */
export async function fenceRunLeases(
  steps: OperationSteps,
  sys: ExecutionContext,
  args: {
    readonly runId: string;
    readonly ttlMs: number;
    readonly need: { readonly publication: boolean; readonly liveRelease: boolean };
    readonly lostMessage: (renewError: string | null) => string;
  },
): Promise<
  { readonly ok: true; readonly until: number } | { readonly ok: false; readonly message: string }
> {
  const startedAt = Date.now();
  const r = await execute(steps.registry, steps.adapter, sys, "deploy.renew_run_lease", {
    runId: args.runId,
    ttlMs: args.ttlMs,
  });
  if (!r.ok) return { ok: false, message: args.lostMessage(describeError(r.error)) };
  const beat = r.value as DeployRunBeat;
  const held =
    beat.running &&
    (!args.need.publication || beat.publication === "renewed") &&
    (!args.need.liveRelease || beat.liveRelease === "renewed");
  if (!held) return { ok: false, message: args.lostMessage(null) };
  return { ok: true, until: startedAt + Math.floor(args.ttlMs / 2) };
}
