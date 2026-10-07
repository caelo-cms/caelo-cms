// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 — the quality-audit worker. Runs inside the admin process
 * (CLAUDE.md §11.B Tier 5: background workers share the admin's compute),
 * bootstrapped from apps/admin/src/hooks.server.ts like the redeploy and GC
 * workers.
 *
 * It polls for queued audit runs (`quality_audits.claim_next`, safe across
 * several admin instances), and the Stage flow kicks it right after
 * enqueueing so an audit starts without waiting for the next poll. For
 * each run it resolves the staged build's origin, runs Lighthouse in the
 * child process, and reports through `quality_audits.record_result`. Every
 * failure path reports too: an audit never stays silently unrun.
 *
 * One audit at a time per process: an audit drives a whole Chromium and
 * Lighthouse is CPU-bound, so parallel audits would only slow each other
 * and starve the editor's requests.
 */

import { type DatabaseAdapter, execute, type OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { verifyStagedBuildServed } from "../deploy/verify-staged-serve.js";
import type { AuditJob } from "./lighthouse-protocol.js";
import { type AuditJobResult, runAuditJob } from "./lighthouse-runner.js";

const WORKER_CTX: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "quality-audit-worker",
};

const DEFAULT_INTERVAL_MS = 15_000;

/** A run as `quality_audits.claim_next` hands it out. */
export interface ClaimedAuditRun {
  readonly auditRunId: string;
  readonly deployRunId: string;
  readonly performanceRuns: number;
  readonly pageUrlStyle: "directory" | "no-extension";
  readonly previewUrl: string | null;
  readonly pages: readonly { readonly pageId: string; readonly currentPath: string }[];
}

export type StagingOrigin =
  | { readonly ok: true; readonly baseUrl: string }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Where the audit browser can load THIS deploy run's staged build, per
 * provider. Fails with an operator-actionable reason instead of guessing.
 */
export async function resolveStagingOrigin(
  run: ClaimedAuditRun,
  env: { readonly provider?: string; readonly stagingBaseUrl?: string },
): Promise<StagingOrigin> {
  const provider = env.provider ?? "";
  if (provider === "gcp-firebase") {
    if (!run.previewUrl) {
      return {
        ok: false,
        code: "staging-unresolvable",
        message: `deploy run ${run.deployRunId} has no Firebase preview channel URL — Stage again to publish a fresh preview channel`,
      };
    }
    return { ok: true, baseUrl: run.previewUrl };
  }
  if (provider === "" || provider === "self-hosted") {
    // Same origin the Stage flow's own serve check and Preview link use.
    const baseUrl = env.stagingBaseUrl ?? "http://localhost:8081";
    const served = await verifyStagedBuildServed({
      stagingBaseUrl: baseUrl,
      runId: run.deployRunId,
    });
    if (!served.served) {
      return {
        ok: false,
        code: "staging-unreachable",
        message: `staging at ${baseUrl} does not serve deploy run ${run.deployRunId}: ${served.reason}`,
      };
    }
    return { ok: true, baseUrl };
  }
  return {
    ok: false,
    code: "provider-unsupported",
    message: `quality audits cannot reach the staged build on provider "${provider}" yet: its staging is only served through the sign-in-protected admin preview, which the audit browser cannot open. The audit is recorded as failed so the gap stays visible.`,
  };
}

/** URL of a page on the staged origin, matching the generator's output
 *  layout (directory style ends in `/`, so no redirect is audited). */
export function stagedPageUrl(
  baseUrl: string,
  currentPath: string,
  style: "directory" | "no-extension",
): string {
  const base = baseUrl.replace(/\/+$/, "");
  const path = currentPath.startsWith("/") ? currentPath : `/${currentPath}`;
  if (path === "/") return `${base}/`;
  const trimmed = path.replace(/\/+$/, "");
  return style === "directory" ? `${base}${trimmed}/` : `${base}${trimmed}`;
}

interface WorkerDeps {
  readonly adapter: DatabaseAdapter;
  readonly registry: OperationRegistry;
  /** Override the Lighthouse runner (tests). */
  readonly runJob?: (job: AuditJob) => Promise<AuditJobResult>;
  /** Override provider env (tests). */
  readonly env?: { readonly provider?: string; readonly stagingBaseUrl?: string };
}

async function record(
  deps: WorkerDeps,
  auditRunId: string,
  baseUrl: string | null,
  outcome:
    | { kind: "completed"; pages: unknown[]; pageErrors: unknown[] }
    | { kind: "failed"; code: string; message: string },
): Promise<void> {
  const r = await execute(deps.registry, deps.adapter, WORKER_CTX, "quality_audits.record_result", {
    auditRunId,
    baseUrl,
    outcome,
  });
  if (!r.ok) {
    // The run stays `running` and is closed as `interrupted` by the stale
    // sweep; log loudly so the cause is in the server log.
    console.error("[quality-audit-worker] record_result failed", { auditRunId, error: r.error });
  }
}

/** Audit one claimed run end to end. Exported for tests. */
export async function processClaimedRun(deps: WorkerDeps, run: ClaimedAuditRun): Promise<void> {
  const env = deps.env ?? {
    provider: process.env.CAELO_PROVIDER,
    stagingBaseUrl: process.env.CAELO_STAGING_BASE_URL,
  };
  if (run.pages.length === 0) {
    await record(deps, run.auditRunId, null, {
      kind: "failed",
      code: "no-pages",
      message:
        "none of the pages selected for this audit is published on staging any more — Stage again to audit the current pages",
    });
    return;
  }
  const origin = await resolveStagingOrigin(run, env);
  if (!origin.ok) {
    await record(deps, run.auditRunId, null, {
      kind: "failed",
      code: origin.code,
      message: origin.message,
    });
    return;
  }
  const job: AuditJob = {
    pages: run.pages.map((p) => ({
      pageId: p.pageId,
      url: stagedPageUrl(origin.baseUrl, p.currentPath, run.pageUrlStyle),
    })),
    performanceRuns: run.performanceRuns,
  };
  const result = await (deps.runJob ?? runAuditJob)(job);
  if (!result.ok) {
    await record(deps, run.auditRunId, origin.baseUrl, {
      kind: "failed",
      code: result.failure.code,
      message: result.failure.message,
    });
    return;
  }
  await record(deps, run.auditRunId, origin.baseUrl, {
    kind: "completed",
    pages: result.pages.map((p) => ({
      pageId: p.pageId,
      url: p.url,
      ...(p.finalUrl ? { finalUrl: p.finalUrl } : {}),
      measurement: p.measurement,
      performanceRuns: [...p.performanceRuns],
    })),
    pageErrors: [...result.pageErrors],
  });
}

/**
 * Claim and process queued runs until none is left. Returns how many runs
 * were processed. Exported for tests; the worker loop calls it.
 */
export async function drainAuditQueue(deps: WorkerDeps): Promise<number> {
  let processed = 0;
  for (;;) {
    const claimed = await execute(
      deps.registry,
      deps.adapter,
      WORKER_CTX,
      "quality_audits.claim_next",
      {},
    );
    if (!claimed.ok) {
      console.error("[quality-audit-worker] claim_next failed", claimed.error);
      return processed;
    }
    const run = (claimed.value as { run: ClaimedAuditRun | null }).run;
    if (!run) return processed;
    try {
      await processClaimedRun(deps, run);
    } catch (e) {
      await record(deps, run.auditRunId, null, {
        kind: "failed",
        code: "worker-crashed",
        message: e instanceof Error ? e.message : String(e),
      });
    }
    processed += 1;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let draining: Promise<number> | null = null;
let workerDeps: WorkerDeps | null = null;

/** Run one drain unless one is in flight (never two audits at once). */
function tick(): void {
  if (!workerDeps || draining) return;
  draining = drainAuditQueue(workerDeps)
    .catch((e) => {
      console.error("[quality-audit-worker] drain failed", e);
      return 0;
    })
    .finally(() => {
      draining = null;
    });
}

/**
 * Start the worker. Idempotent — a second call is a no-op. Call once from
 * the admin's hooks.server.ts.
 */
export function startQualityAuditWorker(deps: WorkerDeps & { readonly intervalMs?: number }): void {
  if (timer) return;
  workerDeps = deps;
  timer = setInterval(tick, deps.intervalMs ?? DEFAULT_INTERVAL_MS);
  timer.unref?.();
  tick();
}

/** Wake the worker now (the Stage flow calls this after enqueueing). A
 *  no-op when the worker is not started in this process. */
export function kickQualityAuditWorker(): void {
  tick();
}
