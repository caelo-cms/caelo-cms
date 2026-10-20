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
 * each run it resolves the staged build's origin, runs the registered
 * checks (#727, quality/checks/registry.ts) — the cheap findings checks
 * over every page, and Lighthouse in the child process when the Stage
 * needs it — and reports through `quality_audits.record_result`. Every
 * failure path reports too: an audit never stays silently unrun.
 *
 * One audit at a time per process. On cloud installs the Lighthouse runs
 * themselves leave the admin (#875, lighthouse-runner-select.ts): every run
 * gets its own container, in parallel, so no run shares a CPU with another
 * or with the editor's requests. Self-hosted runs them in the in-process
 * child, one after another.
 */

import { existsSync } from "node:fs";
import { type DatabaseAdapter, execute, type OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { NOT_FOUND_PAGE_FILE } from "@caelo-cms/static-generator";
import { trimTrailingSlashes, verifyStagedBuildServed } from "../deploy/verify-staged-serve.js";
import { localBuildArchiveDir } from "../ops/deploy.js";
import { linkSourcesFromOps, referenceSourcesFromOps } from "./checks/links-sources.js";
import { type CheckRegistry, createCoreCheckRegistry } from "./checks/registry.js";
import { runChecksOnStagedBuild } from "./checks/run-staged.js";
import { structureSourcesFromOps } from "./checks/structure-sources.js";
import type { AuditJob } from "./lighthouse-protocol.js";
import type { AuditJobResult } from "./lighthouse-runner.js";
import { lighthouseRunnerFromEnv } from "./lighthouse-runner-select.js";
import type { StagedBuildSource } from "./staged-build-source.js";
import {
  gcsStagingSource,
  localBuildSource,
  type StagedFileSource,
  serveStagedBuild,
} from "./staged-origin.js";

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
  /** #650 — the staging origin the build was rendered for (`deploy_runs.site_url`). */
  readonly siteUrl: string | null;
  readonly env: string;
  readonly outDir: string;
  /** Lighthouse's pages; empty when the Stage needs no Lighthouse. */
  readonly pages: readonly ClaimedAuditPage[];
  /** #727 — every published page, for the findings checks. */
  readonly checkPages: readonly ClaimedAuditPage[];
}

/** A page of a claimed audit run. */
export interface ClaimedAuditPage {
  readonly pageId: string;
  readonly currentPath: string;
  /** #802 — the designated 404 page, built as `/404.html` instead of at its path. */
  readonly isNotFoundPage: boolean;
}

export type StagingOrigin =
  | {
      readonly ok: true;
      /** Where the audit browser loads the build. */
      readonly baseUrl: string;
      /**
       * #650 — the origin operators know staging by, when it differs from
       * `baseUrl`: on gcp-firebase the audit loads the preview channel
       * directly (not through the gated gateway, whose cold start would
       * skew the performance scores), but the recorded report names
       * `https://staging.<domain>`.
       */
      readonly displayBaseUrl?: string;
      /** Set for a loopback origin this audit owns: close it afterwards. */
      readonly close?: () => Promise<void>;
      /**
       * #875 — how a parallel audit task, which cannot open this admin's
       * loopback origin, reaches the same build. Absent when `baseUrl` is
       * reachable from anywhere (a preview channel, self-hosted staging).
       */
      readonly stagedBuild?: StagedBuildSource;
    }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** Provider environment the origin resolution reads. */
export interface OriginEnv {
  readonly provider?: string;
  readonly stagingBaseUrl?: string;
  /**
   * gcp: the live site origin (`CAELO_SITE_URL`) whose `/api/*` reaches
   * the gateway; the loopback origin forwards plugin calls there.
   */
  readonly siteUrl?: string;
  /** Override the file source of a loopback origin (tests). */
  readonly loopbackSource?: (run: ClaimedAuditRun) => StagedFileSource;
}

/**
 * The file source for providers whose staging the browser cannot open.
 * gcp: the staging bucket (the build archive on disk is ephemeral and may
 * live on another instance). aws / azure: the build archive this process
 * wrote, when it is still here. Null: nothing to serve from.
 */
function loopbackSourceFor(
  provider: string,
  run: ClaimedAuditRun,
): { source: StagedFileSource } | { code: string; message: string } {
  if (provider === "gcp") {
    try {
      return { source: gcsStagingSource(run.deployRunId) };
    } catch (e) {
      return {
        code: "staging-unresolvable",
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }
  const dir = localBuildArchiveDir({
    provider,
    env: run.env,
    outDir: run.outDir,
    runId: run.deployRunId,
  });
  if (!existsSync(dir)) {
    return {
      code: "build-unavailable",
      message: `the files of staged build ${run.deployRunId} are not on this admin instance (${dir}) and provider "${provider}" has no staging URL to audit — Stage again and the check runs on the instance that built it`,
    };
  }
  return { source: localBuildSource(dir) };
}

/**
 * Where the audit browser can load THIS deploy run's staged build, per
 * provider. Fails with an operator-actionable reason instead of guessing.
 */
export async function resolveStagingOrigin(
  run: ClaimedAuditRun,
  env: OriginEnv,
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
    // The preview channel is the origin staging.<domain> proxies to; the
    // audit hits it directly and reports under the staging host THIS build
    // was rendered for (the run's site_url) — not the current setting, which
    // an Owner may have moved while the audit was queued.
    if (!run.siteUrl) {
      return {
        ok: false,
        code: "staging-unresolvable",
        message: `staged build ${run.deployRunId} recorded no staging host, so the audit cannot name the staging site it checked — set the staging host under Settings → Domains (or run \`cms-provision upgrade\`) and Stage again`,
      };
    }
    return { ok: true, baseUrl: run.previewUrl, displayBaseUrl: run.siteUrl };
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
  if (provider === "gcp" || provider === "aws" || provider === "azure") {
    // No staging URL the browser can open (gcp: private bucket behind the
    // IAP-gated admin proxy): serve the run's files on a loopback port.
    const apiOrigin = provider === "gcp" ? env.siteUrl?.trim() : undefined;
    if (provider === "gcp" && !apiOrigin) {
      return {
        ok: false,
        code: "staging-unresolvable",
        message:
          "CAELO_SITE_URL is not set on the admin, so the audit cannot reach the API gateway that plugin components on the staged pages call — run `cms-provision upgrade`",
      };
    }
    let source: StagedFileSource;
    if (env.loopbackSource) {
      source = env.loopbackSource(run);
    } else {
      const found = loopbackSourceFor(provider, run);
      if ("code" in found) return { ok: false, code: found.code, message: found.message };
      source = found.source;
    }
    const origin = await serveStagedBuild(source, apiOrigin ? { apiOrigin } : {});
    return {
      ok: true,
      baseUrl: origin.baseUrl,
      close: origin.close,
      ...(provider === "gcp" && apiOrigin
        ? {
            stagedBuild: {
              kind: "gcs-staging" as const,
              runId: run.deployRunId,
              baseUrl: origin.baseUrl,
              apiOrigin,
            },
          }
        : {}),
    };
  }
  return {
    ok: false,
    code: "provider-unsupported",
    message: `quality audits do not know how to reach staging on provider "${provider}" — the audit is recorded as failed so the gap stays visible`,
  };
}

/**
 * `url` on the audited origin re-addressed to the origin operators know
 * staging by (#650). URLs outside `baseUrl` (a redirect away) stay as they
 * are. Pure; exported for tests.
 */
export function toDisplayUrl(url: string, baseUrl: string, displayBaseUrl: string): string {
  const base = trimTrailingSlashes(baseUrl);
  if (url !== base && !url.startsWith(`${base}/`) && !url.startsWith(`${base}?`)) return url;
  return `${trimTrailingSlashes(displayBaseUrl)}${url.slice(base.length)}`;
}

/** URL of a page on the staged origin, matching the generator's output
 *  layout (directory style ends in `/`, so no redirect is audited). */
export function stagedPageUrl(
  baseUrl: string,
  currentPath: string,
  style: "directory" | "no-extension",
): string {
  const base = trimTrailingSlashes(baseUrl);
  const path = currentPath.startsWith("/") ? currentPath : `/${currentPath}`;
  if (path === "/") return `${base}/`;
  const trimmed = trimTrailingSlashes(path);
  return style === "directory" ? `${base}${trimmed}/` : `${base}${trimmed}`;
}

/**
 * #802 — where the staged build serves `page`: the designated 404 page is
 * written to `/404.html` and nowhere else (its own path answers 404 by
 * design), every other page at {@link stagedPageUrl}.
 */
export function stagedUrlOfPage(
  baseUrl: string,
  page: Pick<ClaimedAuditPage, "currentPath" | "isNotFoundPage">,
  style: "directory" | "no-extension",
): string {
  if (page.isNotFoundPage) return `${trimTrailingSlashes(baseUrl)}/${NOT_FOUND_PAGE_FILE}`;
  return stagedPageUrl(baseUrl, page.currentPath, style);
}

interface WorkerDeps {
  readonly adapter: DatabaseAdapter;
  readonly registry: OperationRegistry;
  /** The checks to run; core's (Lighthouse + core findings checks) when
   *  omitted. The plugin `checks` composition point (#727) passes one with plugin checks added. */
  readonly checks?: CheckRegistry;
  /** Override the Lighthouse runner (tests). */
  readonly runJob?: (job: AuditJob) => Promise<AuditJobResult>;
  /** Override the page fetch of the findings checks (tests). */
  readonly fetchPage?: typeof fetch;
  /** Override provider env (tests). */
  readonly env?: OriginEnv;
}

let coreChecks: CheckRegistry | null = null;

/** Core's registry, built once per process (one adapter per process). */
function defaultChecks(deps: WorkerDeps): CheckRegistry {
  coreChecks ??= createCoreCheckRegistry({
    lighthouse: lighthouseRunnerFromEnv(process.env),
    structure: structureSourcesFromOps(deps.registry, deps.adapter, WORKER_CTX),
    links: linkSourcesFromOps(deps.registry, deps.adapter, WORKER_CTX),
    references: referenceSourcesFromOps(deps.registry, deps.adapter, WORKER_CTX),
  });
  return coreChecks;
}

async function record(
  deps: WorkerDeps,
  auditRunId: string,
  baseUrl: string | null,
  outcome:
    | { kind: "completed"; pages: unknown[]; pageErrors: unknown[]; checks: unknown }
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
  } else if ((r.value as { status: string }).status === "discarded") {
    console.log(
      `[quality-audit-worker] audit ${auditRunId} was deleted while it ran; result dropped`,
    );
  }
}

/** Audit one claimed run end to end. Exported for tests. */
export async function processClaimedRun(deps: WorkerDeps, run: ClaimedAuditRun): Promise<void> {
  const env = deps.env ?? {
    provider: process.env.CAELO_PROVIDER,
    stagingBaseUrl: process.env.CAELO_STAGING_BASE_URL,
    siteUrl: process.env.CAELO_SITE_URL,
  };
  if (run.pages.length === 0 && run.checkPages.length === 0) {
    await record(deps, run.auditRunId, null, {
      kind: "failed",
      code: "no-pages",
      message:
        "none of the pages selected for this audit is published on staging any more — Stage again to audit the current pages",
    });
    return;
  }
  const checks = deps.checks ?? defaultChecks(deps);
  const runLighthouse = deps.runJob ?? checks.lighthouse()?.run;
  if (run.pages.length > 0 && !runLighthouse) {
    await record(deps, run.auditRunId, null, {
      kind: "failed",
      code: "lighthouse-unavailable",
      message:
        "this Stage needs a Lighthouse audit but no Lighthouse check is registered in this admin process — a Caelo bug; report it with bug_report",
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
  const pageUrl = (page: ClaimedAuditPage) =>
    stagedUrlOfPage(origin.baseUrl, page, run.pageUrlStyle);
  let result: AuditJobResult | null = null;
  let checked: Awaited<ReturnType<typeof runChecksOnStagedBuild>>;
  try {
    checked = await runChecksOnStagedBuild(
      checks.findingChecks(),
      run.checkPages.map((p) => ({
        pageId: p.pageId,
        path: p.currentPath,
        url: pageUrl(p),
        ...(p.isNotFoundPage ? { notFoundPage: true as const } : {}),
      })),
      {
        baseUrl: origin.baseUrl,
        ...(origin.displayBaseUrl ? { displayBaseUrl: origin.displayBaseUrl } : {}),
      },
      deps.fetchPage,
    );
    if (run.pages.length > 0 && runLighthouse) {
      result = await runLighthouse({
        pages: run.pages.map((p) => ({ pageId: p.pageId, url: pageUrl(p) })),
        performanceRuns: run.performanceRuns,
        ...(origin.stagedBuild ? { stagedBuild: origin.stagedBuild } : {}),
      });
    }
  } finally {
    await origin.close?.();
  }
  // Reports name the staging host, never the internal preview origin.
  const shown = origin.displayBaseUrl ?? origin.baseUrl;
  const display = (url: string) =>
    origin.displayBaseUrl ? toDisplayUrl(url, origin.baseUrl, origin.displayBaseUrl) : url;
  const displayText = (text: string) =>
    origin.displayBaseUrl ? text.split(trimTrailingSlashes(origin.baseUrl)).join(shown) : text;
  if (result && !result.ok) {
    await record(deps, run.auditRunId, shown, {
      kind: "failed",
      code: result.failure.code,
      message: displayText(result.failure.message),
    });
    return;
  }
  await record(deps, run.auditRunId, shown, {
    kind: "completed",
    pages: (result?.pages ?? []).map((p) => ({
      pageId: p.pageId,
      url: display(p.url),
      ...(p.finalUrl ? { finalUrl: display(p.finalUrl) } : {}),
      // #667 — flagged resource URLs move to the shown origin with the page
      // URL, so findings compare and read consistently (a same-site asset on
      // the preview channel must not look third-party next to the page).
      measurement: {
        ...p.measurement,
        failingAudits: p.measurement.failingAudits.map((a) =>
          a.elements
            ? {
                ...a,
                elements: a.elements.map((el) => (el.url ? { ...el, url: display(el.url) } : el)),
              }
            : a,
        ),
      },
      performanceRuns: [...p.performanceRuns],
    })),
    pageErrors: (result?.pageErrors ?? []).map((e) => ({
      ...e,
      url: display(e.url),
      message: displayText(e.message),
    })),
    checks: {
      ...checked,
      pages: checked.pages.map((p) => ({ ...p, url: display(p.url) })),
      findings: checked.findings.map((f) => ({ ...f, message: displayText(f.message) })),
      errors: checked.errors.map((e) => ({
        ...e,
        ...(e.url ? { url: display(e.url) } : {}),
        message: displayText(e.message),
      })),
    },
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
    if (!run) {
      // claim_next's sweep may just have ended interrupted or superseded
      // automatic runs; they are settled like finished ones.
      await settleAutomaticStages(deps);
      return processed;
    }
    try {
      await processClaimedRun(deps, run);
    } catch (e) {
      await record(deps, run.auditRunId, null, {
        kind: "failed",
        code: "worker-crashed",
        message: e instanceof Error ? e.message : String(e),
      });
    }
    // An audit queued by the automatic redeploy publishes (or stops) now
    // that its result is in; a no-op when no automatic Stage ended.
    await settleAutomaticStages(deps);
    processed += 1;
  }
}

/** Publish or stop every automatic Stage whose audit ended (#553). */
async function settleAutomaticStages(deps: WorkerDeps): Promise<void> {
  const settled = await execute(
    deps.registry,
    deps.adapter,
    WORKER_CTX,
    "quality_audits.settle_auto_publish",
    {},
  );
  if (!settled.ok) {
    console.error("[quality-audit-worker] settle_auto_publish failed", settled.error);
    return;
  }
  const { settled: runs } = settled.value as {
    settled: { auditRunId: string; outcome: string; message: string | null }[];
  };
  for (const r of runs) {
    if (r.outcome === "blocked") {
      console.warn(
        `[quality-audit-worker] automatic publish of audit ${r.auditRunId} stopped: ${r.message}`,
      );
    }
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
