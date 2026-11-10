// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 / #1359 — audit one claimed run: resolve where the staged
 * build can be read, run the registered checks (#727,
 * quality/checks/registry.ts) — the cheap findings checks over every page,
 * and Lighthouse when the Stage needs it — and shape the outcome for
 * `quality_audits.record_result`. Every failure path ends in an outcome
 * too: an audit never stays silently unrun.
 *
 * Since #1359 this runs in the quality audit's own job, not in the admin
 * process between requests (quality/audit-job.ts; CLAUDE.md §11.B Tier 5):
 * a Cloud Run job on Google Cloud, the admin's own process on self-hosted
 * and development installs. It reads nothing from the database itself:
 * the check sources come in as functions (the job asks the admin for
 * them), and the outcome goes back as a value the job reports.
 *
 * The Lighthouse runs themselves leave even the job on cloud installs
 * (#875, lighthouse-runner-select.ts): every run gets its own container,
 * in parallel, so no run shares a CPU with another. Self-hosted runs them
 * in the in-process child, one after another.
 */

import { existsSync } from "node:fs";
import { NOT_FOUND_PAGE_FILE } from "@caelo-cms/static-generator";
import { trimTrailingSlashes, verifyStagedBuildServed } from "../deploy/verify-staged-serve.js";
import { localBuildArchiveDir } from "../ops/deploy-common.js";
import type { CheckRegistry, LighthouseRunner } from "./checks/registry.js";
import { runChecksOnStagedBuild } from "./checks/run-staged.js";
import type { AuditJobResult } from "./lighthouse-runner.js";
import type { StagedBuildSource } from "./staged-build-source.js";
import {
  localBuildSource,
  type StagedFileSource,
  serveStagedBuild,
  stagingSlotSource,
} from "./staged-origin.js";

/** A run as `quality_audits.claim` hands it out. */
export interface ClaimedAuditRun {
  readonly auditRunId: string;
  readonly deployRunId: string;
  readonly performanceRuns: number;
  readonly pageUrlStyle: "directory" | "no-extension";
  /**
   * #1330 — where the run's complete files lie in staging storage
   * (`publish_summary.stagingLocation`: a slot of the staging bucket on
   * gcp / gcp-firebase); null for a run staged before it.
   */
  readonly stagingLocation: string | null;
  /** The origin operators know staging by (`https://<staging host>`); null when no host is set. */
  readonly stagingOrigin: string | null;
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
       * `baseUrl`: on gcp and gcp-firebase the audit loads the staged build
       * on a loopback origin (not through the gated staging gateway, whose
       * cold start and streaming rewrite would skew the scores, #875), but
       * the recorded report names `https://<staging host>`.
       */
      readonly displayBaseUrl?: string;
      /** Set for a loopback origin this audit owns: close it afterwards. */
      readonly close?: () => Promise<void>;
      /**
       * #875 — how a parallel audit task, which cannot open this admin's
       * loopback origin, reaches the same build. Absent when `baseUrl` is
       * reachable from anywhere (self-hosted staging).
       */
      readonly stagedBuild?: StagedBuildSource;
    }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** Provider environment the origin resolution reads. */
export interface OriginEnv {
  readonly provider?: string;
  readonly stagingBaseUrl?: string;
  /** Override the file source of a loopback origin (tests). */
  readonly loopbackSource?: (run: ClaimedAuditRun) => StagedFileSource;
}

/**
 * The file source for providers whose staging the browser cannot open
 * without the gate. gcp / gcp-firebase: the run's staging slot (#1330).
 * self-hosted (the staging host is gated since #1330), aws / azure: the
 * build archive this process wrote, when it is still here.
 */
function loopbackSourceFor(
  provider: string,
  run: ClaimedAuditRun,
): { source: StagedFileSource } | { code: string; message: string } {
  if (provider === "gcp" || provider === "gcp-firebase") {
    if (!run.stagingLocation) {
      return {
        code: "staging-unresolvable",
        message: `deploy run ${run.deployRunId} recorded no staging slot (it was staged by an older release) — Stage again`,
      };
    }
    return { source: stagingSlotSource(run.stagingLocation, run.deployRunId) };
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
  if (provider === "") {
    // A development checkout: its local staging port serves `current/`, the
    // same origin the Stage flow's own serve check and Preview link use.
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
  if (
    provider === "gcp" ||
    provider === "gcp-firebase" ||
    provider === "self-hosted" ||
    provider === "aws" ||
    provider === "azure"
  ) {
    // The build on a loopback port, so the measurement never goes through
    // the gated staging gateway (#875). Plugin calls are answered there with
    // the staging stub: an audit writes no visitor data anywhere (#763 N4).
    let source: StagedFileSource;
    if (env.loopbackSource) {
      source = env.loopbackSource(run);
    } else {
      const found = loopbackSourceFor(provider, run);
      if ("code" in found) return { ok: false, code: found.code, message: found.message };
      source = found.source;
    }
    const origin = await serveStagedBuild(source);
    const slotted = (provider === "gcp" || provider === "gcp-firebase") && run.stagingLocation;
    return {
      ok: true,
      baseUrl: origin.baseUrl,
      ...(run.stagingOrigin ? { displayBaseUrl: run.stagingOrigin } : {}),
      close: origin.close,
      ...(slotted
        ? {
            stagedBuild: {
              kind: "staging-slot" as const,
              location: run.stagingLocation as string,
              runId: run.deployRunId,
              baseUrl: origin.baseUrl,
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

/** What one audit needs besides the run: its checks and how it reaches staging. */
export interface AuditRunDeps {
  /** The checks to run: core's and the active plugins' (audit-job.ts builds them). */
  readonly checks: CheckRegistry;
  /** Override the Lighthouse runner (tests); the registry's otherwise. */
  readonly runJob?: LighthouseRunner;
  /** Override the page fetch of the findings checks (tests). */
  readonly fetchPage?: typeof fetch;
  /** Override provider env (tests). */
  readonly env?: OriginEnv;
}

/** What one audit ends with: `quality_audits.record_result`'s input without the run id. */
export interface AuditReport {
  /** The staging origin the report names (null when it could not be resolved). */
  readonly baseUrl: string | null;
  readonly outcome:
    | {
        readonly kind: "completed";
        readonly pages: unknown[];
        readonly pageErrors: unknown[];
        readonly checks: unknown;
      }
    | { readonly kind: "failed"; readonly code: string; readonly message: string };
}

function failed(baseUrl: string | null, code: string, message: string): AuditReport {
  return { baseUrl, outcome: { kind: "failed", code, message } };
}

/**
 * Audit one claimed run end to end and return what to record. Throws only
 * on a bug; every expected failure is a `failed` outcome.
 */
export async function auditClaimedRun(
  run: ClaimedAuditRun,
  deps: AuditRunDeps,
): Promise<AuditReport> {
  const env = deps.env ?? {
    provider: process.env.CAELO_PROVIDER,
    stagingBaseUrl: process.env.CAELO_STAGING_BASE_URL,
  };
  if (run.pages.length === 0 && run.checkPages.length === 0) {
    return failed(
      null,
      "no-pages",
      "none of the pages selected for this audit is published on staging any more — Stage again to audit the current pages",
    );
  }
  const { checks } = deps;
  const runLighthouse = deps.runJob ?? checks.lighthouse()?.run;
  if (run.pages.length > 0 && !runLighthouse) {
    return failed(
      null,
      "lighthouse-unavailable",
      "this Stage needs a Lighthouse audit but no Lighthouse check is registered for the audit — a Caelo bug; report it with bug_report",
    );
  }
  const origin = await resolveStagingOrigin(run, env);
  if (!origin.ok) return failed(null, origin.code, origin.message);
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
    return failed(shown, result.failure.code, displayText(result.failure.message));
  }
  return {
    baseUrl: shown,
    outcome: {
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
    },
  };
}
