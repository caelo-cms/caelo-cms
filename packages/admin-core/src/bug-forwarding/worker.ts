// SPDX-License-Identifier: MPL-2.0

/**
 * Bug-forwarding worker (epic #901). Runs in every admin process; the claim
 * lease in `bug_forwarding.claim_due` keeps instances off each other's rows.
 *
 * Every tick (1 min): when the Owner opted in, claim due reports, make sure
 * the intake knows this install's key, send each report and record the
 * answer. Every few hours it also refreshes the upstream status of the
 * clusters this install reported into, so /settings/bugs can say "fixed in
 * vX" without anyone polling GitHub.
 *
 * All network calls run between transactions. Failures are recorded on the
 * rows (forward_error) and retried with backoff; nothing is swallowed.
 *
 * Bootstrapped once per process from apps/admin/src/hooks.server.ts.
 */

import { type DatabaseAdapter, execute, type OperationRegistry } from "@caelo-cms/query-api";
import type { BugIntakeReport, ExecutionContext } from "@caelo-cms/shared";
import { SYSTEM_ACTOR_ID } from "../audit.js";
import type { BugIntakeClient, IntakeIdentity, IntakeOutcome } from "./client.js";

const SEND_INTERVAL_MS = 60_000;
const STATUS_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CLAIM_BATCH = 20;

export interface BugForwardingWorkerOpts {
  adapter: DatabaseAdapter;
  registry: OperationRegistry;
  client: BugIntakeClient;
  intervalMs?: number;
  statusIntervalMs?: number;
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

/** Send every due report once. Exported for tests. */
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

/** Refresh upstream status of stale clusters once. Exported for tests. */
export async function refreshClusterStatus(opts: BugForwardingWorkerOpts): Promise<number> {
  const state = await run<{ enabled: boolean }>(opts, "bug_forwarding.get", {});
  if (!state.enabled) return 0;
  const { clusterIds } = await run<{ clusterIds: string[] }>(
    opts,
    "bug_forwarding.clusters_to_refresh",
    {
      staleAfterSeconds: Math.floor((opts.statusIntervalMs ?? STATUS_INTERVAL_MS) / 1000),
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

let sendHandle: ReturnType<typeof setInterval> | null = null;
let statusHandle: ReturnType<typeof setInterval> | null = null;

/** Start both loops. Idempotent. */
export function startBugForwardingWorker(opts: BugForwardingWorkerOpts): void {
  if (sendHandle) return;
  const send = () =>
    void forwardDueReports(opts).catch((e) => {
      console.error("[bug-forwarding] send tick failed:", (e as Error).message);
    });
  const status = () =>
    void refreshClusterStatus(opts).catch((e) => {
      console.error("[bug-forwarding] status refresh failed:", (e as Error).message);
    });
  send();
  status();
  sendHandle = setInterval(send, opts.intervalMs ?? SEND_INTERVAL_MS);
  statusHandle = setInterval(status, opts.statusIntervalMs ?? STATUS_INTERVAL_MS);
}

/** Test-only. */
export function stopBugForwardingWorker(): void {
  if (sendHandle) clearInterval(sendHandle);
  if (statusHandle) clearInterval(statusHandle);
  sendHandle = null;
  statusHandle = null;
}
