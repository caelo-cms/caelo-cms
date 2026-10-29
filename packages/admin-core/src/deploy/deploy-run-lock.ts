// SPDX-License-Identifier: MPL-2.0

/**
 * Tells a deploy run that is still building from one that died (#1003).
 *
 * A Stage, Publish live or plugin-data build commits its `deploy_runs` row
 * as `running` when it starts — so the deployments page shows it and its
 * progress. If the process building it dies (crash, Cloud Run instance
 * replaced, an unexpected throw), nothing would ever finish the row. Every
 * run of this release holds NO transaction while it builds (#1211, #1225):
 * it holds a lease on its own row instead, `deploy_runs.lease_expires_at`,
 * set when the row is committed and pushed forward by
 * {@link DeployRunHeartbeat} while it runs. A running row whose lease lapsed
 * has nothing behind it any more.
 *
 * Rolling update: the previous release built Publish live and plugin data
 * inside one transaction and told such a run by a transaction-scoped
 * advisory lock on its run id ({@link DEPLOY_RUN_LOCK_PREFIX}), held from
 * before the row existed until that transaction ended. Its rows carry no
 * lease (NULL), so a lease-less running row is still judged by that lock.
 *
 * Either way such a run is safe to mark failed (the start of the next run
 * sweeps them). Ending a leased run clears its lease in the same update: the
 * database refuses to end a run whose lease is live otherwise (migration
 * 0393's guard, for the previous release's sweep during a rolling update).
 * A lease expiring on a timer is right here: it guards a process, not an
 * editor's change — a dead process cannot release anything.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";

/** Prefix of the previous release's per-run advisory-lock key (rolling updates; regression tests). */
export const DEPLOY_RUN_LOCK_PREFIX = "caelo:deploy-run:";

/**
 * How long a run's lease (and a lease it holds, deploy_leases) outlives
 * its last heartbeat: long enough that a briefly slow database does not
 * end a healthy build, short enough that a crashed Stage blocks the next
 * one for two minutes at most.
 */
export const DEPLOY_RUN_LEASE_TTL_MS = 120_000;

/** Heartbeat interval: a quarter of the TTL, so three missed beats still keep the lease. */
export const DEPLOY_RUN_HEARTBEAT_MS = DEPLOY_RUN_LEASE_TTL_MS / 4;

/**
 * True when nothing builds `runId` any more: its lease lapsed, or — for a
 * run without a lease — no transaction holds its advisory lock (taken for
 * the rest of THIS transaction, so the run cannot be resumed while it is
 * being marked failed).
 */
export async function deployRunIsOrphaned(tx: TransactionRunner, runId: string): Promise<boolean> {
  const rows = (await tx.execute(sql`
    SELECT CASE
             WHEN lease_expires_at IS NOT NULL THEN lease_expires_at <= clock_timestamp()
             ELSE pg_try_advisory_xact_lock(hashtext(${DEPLOY_RUN_LOCK_PREFIX} || ${runId}::text))
           END AS free
    FROM deploy_runs WHERE id = ${runId}::uuid
  `)) as unknown as { free: boolean }[];
  return rows[0]?.free === true;
}

/** What one heartbeat learned. */
export interface DeployRunBeat {
  /** False when the row is no longer this run's to finish (marked failed as orphaned). */
  readonly running: boolean;
  /** The staging-publication lease, when the run holds (or held) it. */
  readonly publication: "renewed" | "lost" | "not-held";
  /** The live-release lease (live-release-lock.ts), when the run holds (or held) it. */
  readonly liveRelease: "renewed" | "lost" | "not-held";
}

/**
 * Renews a lease-holding run while it builds (#1211). Every beat is one
 * short op; a failed beat is logged and the next one tries again — the
 * TTL tolerates three misses. When a beat reports that the run lost its
 * row or a lease it needs, `lost` aborts so the run stops before it
 * records anything another publish may have changed.
 */
export class DeployRunHeartbeat {
  readonly #controller = new AbortController();
  readonly #timer: ReturnType<typeof setInterval>;
  #expectsPublication = false;
  #expectsLiveRelease = false;
  #inFlight: Promise<void> | null = null;

  /**
   * @param beat renews the run (and any lease it holds) for one TTL.
   * @param intervalMs time between beats.
   */
  constructor(beat: () => Promise<DeployRunBeat | null>, intervalMs = DEPLOY_RUN_HEARTBEAT_MS) {
    this.#timer = setInterval(() => {
      if (this.#inFlight !== null) return;
      // Judged against what the run held when the beat STARTED: a beat that
      // began before the run acquired the publication lease may answer
      // "not-held" after the acquisition, and says nothing about the lease.
      const expectsPublication = this.#expectsPublication;
      const expectsLiveRelease = this.#expectsLiveRelease;
      this.#inFlight = beat()
        .then((r) => {
          if (r === null) return;
          if (!r.running) this.#lose("the run was marked failed while it still built");
          else if (expectsPublication && r.publication !== "renewed") {
            this.#lose("its staging-publication lease lapsed");
          } else if (expectsLiveRelease && r.liveRelease !== "renewed") {
            this.#lose("its live-release lease lapsed");
          }
        })
        .catch((e: unknown) => {
          console.error("[deploy] run heartbeat failed; retrying on the next beat", {
            error: e instanceof Error ? e.message : String(e),
          });
        })
        .finally(() => {
          this.#inFlight = null;
        });
    }, intervalMs);
  }

  /** Aborts once the run lost its lease (see the class comment). */
  get lost(): AbortSignal {
    return this.#controller.signal;
  }

  /** From now on (or no longer) a beat must also keep the staging-publication lease. */
  expectPublication(held: boolean): void {
    this.#expectsPublication = held;
  }

  /** From now on (or no longer) a beat must also keep the live-release lease. */
  expectLiveRelease(held: boolean): void {
    this.#expectsLiveRelease = held;
  }

  #lose(reason: string): void {
    if (!this.#controller.signal.aborted) this.#controller.abort(new Error(reason));
  }

  /** Stop beating and wait for a beat in flight. Idempotent. */
  async stop(): Promise<void> {
    clearInterval(this.#timer);
    if (this.#inFlight !== null) await this.#inFlight;
  }
}
