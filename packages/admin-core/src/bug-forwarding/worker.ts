// SPDX-License-Identifier: MPL-2.0

/**
 * Bug forwarding (epic #901): two tasks on the scheduler tick (#1140,
 * scheduler/core-tasks.ts). The claim lease in `bug_forwarding.claim_due`
 * keeps concurrent ticks off each other's rows.
 *
 * Every tick: when the Owner opted in, claim due reports, make sure the
 * intake knows this install's key, send each report and record the answer
 * ({@link forwardDueReports}). Every six hours it also refreshes the
 * upstream status of the clusters this install reported into
 * ({@link refreshClusterStatus}), so /settings/bugs can say "fixed in vX"
 * without anyone polling GitHub.
 *
 * All network calls run between transactions. Failures are recorded on the
 * rows (forward_error) and retried with backoff; nothing is swallowed.
 */

import { type DatabaseAdapter, execute, type OperationRegistry } from "@caelo-cms/query-api";
import type { BugIntakeReport, ExecutionContext } from "@caelo-cms/shared";
import { SYSTEM_ACTOR_ID } from "../audit.js";
import type { BugIntakeClient, IntakeIdentity, IntakeOutcome } from "./client.js";

/** How often cluster status is refreshed (the status task's cadence). */
export const BUG_STATUS_REFRESH_SECONDS = 6 * 60 * 60;
const CLAIM_BATCH = 20;

export interface BugForwardingWorkerOpts {
  adapter: DatabaseAdapter;
  registry: OperationRegistry;
  client: BugIntakeClient;
}

let ticks = 0;
const ctx = (): ExecutionContext => ({
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system",
  requestId: `bug-forwarding-${ticks++}`,
});

async function run<T>(opts: BugForwardingWorkerOpts, op: string, input: unknown): Promise<T> {
  const r = await execute(opts.registry, opts.adapter, ctx(), op, input);
  if (!r.ok) throw new Error(`${op}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

/**
 * Make sure the intake has pinned this install's key. Returns the identity,
 * or the outcome that stopped registration.
 */
async function ensureRegistered(
  opts: BugForwardingWorkerOpts,
): Promise<
  { identity: IntakeIdentity } | { blocked: Exclude<IntakeOutcome<null>, { kind: "ok" }> }
> {
  const identity = await run<IntakeIdentity & { registered: boolean }>(
    opts,
    "bug_forwarding.identity",
    {},
  );
  if (identity.registered) return { identity };
  const reg = await opts.client.register(identity);
  if (reg.kind !== "ok") return { blocked: reg };
  await run(opts, "bug_forwarding.mark_registered", { publicKey: identity.publicKey });
  return { identity };
}

/** Send every due report once (the send task's body). */
export async function forwardDueReports(opts: BugForwardingWorkerOpts): Promise<number> {
  const state = await run<{ enabled: boolean }>(opts, "bug_forwarding.get", {});
  if (!state.enabled) return 0;
  const { reports } = await run<{
    reports: Array<{ id: string; attempt: number; payload: BugIntakeReport }>;
  }>(opts, "bug_forwarding.claim_due", { limit: CLAIM_BATCH });
  if (reports.length === 0) return 0;

  const reg = await ensureRegistered(opts);
  for (const report of reports) {
    const outcome =
      "blocked" in reg ? reg.blocked : await opts.client.sendReport(reg.identity, report.payload);
    await run(opts, "bug_forwarding.record_result", {
      reportId: report.id,
      outcome:
        outcome.kind === "ok"
          ? { kind: "sent", cluster: outcome.value }
          : // A registration refusal is not this report's fault; keep it queued.
            {
              kind: "blocked" in reg ? "retry" : outcome.kind,
              error: outcome.error.slice(0, 1000),
            },
    });
  }
  return reports.length;
}

/** Refresh upstream status of stale clusters once (the status task's body). */
export async function refreshClusterStatus(opts: BugForwardingWorkerOpts): Promise<number> {
  const state = await run<{ enabled: boolean }>(opts, "bug_forwarding.get", {});
  if (!state.enabled) return 0;
  const { clusterIds } = await run<{ clusterIds: string[] }>(
    opts,
    "bug_forwarding.clusters_to_refresh",
    {
      staleAfterSeconds: BUG_STATUS_REFRESH_SECONDS,
      limit: 100,
    },
  );
  if (clusterIds.length === 0) return 0;
  const reg = await ensureRegistered(opts);
  if ("blocked" in reg) throw new Error(`bug intake registration: ${reg.blocked.error}`);
  const res = await opts.client.clusterStatus(reg.identity, clusterIds);
  if (res.kind !== "ok") throw new Error(res.error);
  await run(opts, "bug_forwarding.record_cluster_status", { clusters: res.value });
  return res.value.length;
}
