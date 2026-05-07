// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.37 — periodic GC for stale pending proposals.
 *
 * Pending rows accumulate forever if neither approved nor rejected.
 * Operator could end up with hundreds of dead-end proposals from
 * old chats. This worker sweeps `status='pending'` rows older than
 * `staleAfterMs` (default 30 days) → `status='superseded'`. Bell
 * badge stays meaningful, the unified inbox stays actionable.
 *
 * One UPDATE per table, all in one tx. Postgres uses each table's
 * status partial index so this is cheap even on a large queue.
 *
 * Cadence: every 24h. Same bootstrap pattern as
 * release-check-worker.ts; called from hooks.server.ts.
 *
 * Idempotent: re-marking already-superseded rows is a no-op (the
 * WHERE clause filters status='pending' only).
 */

import type { DatabaseAdapter } from "@caelo-cms/query-api";

const POLL_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

interface ProposalGcWorkerOpts {
  readonly adapter: DatabaseAdapter;
  /** Override poll interval (ms). Tests pass smaller values. */
  readonly intervalMs?: number;
  /** Pending rows older than this are superseded. */
  readonly staleAfterMs?: number;
}

const PENDING_TABLES = [
  "deploy_pending_actions",
  "layout_pending_actions",
  "user_pending_actions",
  "role_pending_actions",
  "snapshot_revert_pending_actions",
  "experiment_pending_actions",
  "email_config_pending_actions",
  "ai_providers_pending_actions",
  "mcp_token_pending_actions",
  "template_pending_actions",
  "domain_pending_actions",
  "locale_pending_actions",
  "plugin_rate_limit_proposals",
] as const;

let workerHandle: ReturnType<typeof setInterval> | null = null;

async function gcOnce(opts: ProposalGcWorkerOpts): Promise<{ totalMarked: number }> {
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const cutoffSeconds = Math.floor(staleAfterMs / 1000);
  let totalMarked = 0;
  await opts.adapter.rawAdmin().begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    for (const table of PENDING_TABLES) {
      // Per-table column-name reality:
      //  - age column: most use `created_at`; locale uses `proposed_at`.
      //  - reason column: 11 unified tables use `decision_reason`;
      //    locale_pending_actions uses `decision_note`;
      //    plugin_rate_limit_proposals uses `reason` (NOT NULL DEFAULT '').
      // All have `decided_at`; all share the 'pending'→'superseded'
      // status transition (locale's check supports superseded;
      // plugin_rate_limit's CHECK is ('pending', 'applied', 'rejected')
      // and does NOT include 'superseded' — skip it from auto-supersede
      // until v0.2.41 widens that constraint).
      // v0.2.42 — plugin_rate_limit_proposals' status CHECK was widened
      // to include 'superseded', so it now participates in the sweep.
      const ageColumn = table === "locale_pending_actions" ? "proposed_at" : "created_at";
      const reasonColumn =
        table === "locale_pending_actions"
          ? "decision_note"
          : table === "plugin_rate_limit_proposals"
            ? "reason"
            : "decision_reason";
      const result = (await tx.unsafe(
        `UPDATE ${table}
            SET status = 'superseded',
                decided_at = now(),
                ${reasonColumn} = 'stale: auto-superseded by GC worker'
          WHERE status = 'pending'
            AND ${ageColumn} < now() - make_interval(secs => ${cutoffSeconds})
          RETURNING id`,
      )) as unknown as { id: string }[];
      totalMarked += result.length;
    }
  });
  return { totalMarked };
}

/**
 * Start the periodic GC. Idempotent — second call is a no-op.
 */
export function startProposalGcWorker(opts: ProposalGcWorkerOpts): void {
  if (workerHandle) return;
  // Initial sweep immediately so a fresh boot picks up any old
  // pending rows accumulated during downtime.
  void gcOnce(opts).catch((e) => {
    process.stderr.write(`[proposal-gc-worker] initial sweep failed: ${(e as Error).message}\n`);
  });
  workerHandle = setInterval(() => {
    void gcOnce(opts).catch((e) => {
      process.stderr.write(`[proposal-gc-worker] sweep failed: ${(e as Error).message}\n`);
    });
  }, opts.intervalMs ?? POLL_INTERVAL_MS);
}

/** Test-only — stops the worker so a fresh start call isn't a no-op. */
export function stopProposalGcWorker(): void {
  if (workerHandle) {
    clearInterval(workerHandle);
    workerHandle = null;
  }
}

/** Test-only — runs one sweep synchronously for assertions. */
export const _gcOnceForTests = gcOnce;
