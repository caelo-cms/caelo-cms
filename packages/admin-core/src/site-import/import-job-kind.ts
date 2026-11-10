// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1360 — the admin's side of the site import's job: what it answers
 * to each report (site-import/import-job-wire.ts names them), how the
 * backstop finds a crawl without a job, and how it records one whose job
 * kept dying. The job's side is site-import/crawl-job.ts.
 *
 * Trust: the job read third-party pages, so everything it reports is data
 * the admin checks, never instructions it follows. Every input passes its
 * schema before a handler runs (the foundation's dispatch); every write
 * names the job's own run and stays inside it (the ops filter by run, the
 * screenshot keys live under the run's prefix, a capture key from the job
 * must be one of those); a render is the install's renderer behind the
 * SSRF guard with the admin's own exemptions, within a budget the run's
 * page cap sets. What the job reports reaches the AI as crawled content,
 * marked as such in its tool results. No report builds, stages or
 * publishes anything.
 */

import { createHash } from "node:crypto";
import { execute } from "@caelo-cms/query-api";
import { isExternalUrlBlockedError, type Screenshot } from "@caelo-cms/site-importer";
import { z } from "zod";
import { describeError } from "../ai/tools/_describe-error.js";
import { getExternalScreenshotter } from "../ai/tools/_external-screenshotter.js";
import { getMediaStorage } from "../media/storage.js";
import { renderBudget } from "../ops/imports-crawl.js";
import {
  ActionRefusal,
  type AdminJobDeps,
  REPORTING_JOB_CTX,
  type ReportingJobKindDef,
} from "../reporting-jobs/kind.js";
import { crawlCheckpointSchema, parseStoredCheckpoint } from "./crawl-checkpoint.js";
import { parseCrawlScope } from "./crawl-scope.js";
import { parseExplicitUrls } from "./explicit-urls.js";
import {
  importerAllowedHosts,
  recordBatchCaptures,
  writeRunDesignTokenAggregate,
} from "./ground-truth.js";
import {
  type BatchReport,
  batchReportSchema,
  type CaptureTarget,
  type CrawlStart,
  type FinishReport,
  failReportSchema,
  finishReportSchema,
  pageCaptureSchema,
  pageNoteSchema,
  type RenderAnswer,
  type RenderRequest,
  renderRequestSchema,
} from "./import-job-wire.js";

/** The admin env var naming the crawl's Cloud Run job (Google Cloud). */
export const IMPORT_CRAWL_JOB_ENV_VAR = "CAELO_IMPORT_CRAWL_JOB";

/** The admin env var naming the service account the crawl's reports pass IAP as. */
export const IMPORT_CRAWL_SERVICE_ACCOUNT_ENV_VAR = "CAELO_IMPORT_CRAWL_SERVICE_ACCOUNT";

/** What a self-hosted admin without Chromium says for every render. */
const NO_BROWSER =
  "Playwright/chromium is unavailable in this runtime. Install it " +
  "(`bun node_modules/playwright/cli.js install chromium`) and re-run the import.";

async function op<T>(deps: AdminJobDeps, name: string, input: unknown): Promise<T> {
  const r = await execute(deps.registry, deps.adapter, REPORTING_JOB_CTX, name, input);
  if (!r.ok) throw new Error(`${name} failed: ${describeError(r.error)}`);
  return r.value as T;
}

/** Where the admin stores a run's screenshots: under the run's own prefix. */
function screenshotPrefix(runId: string): string {
  return `import-screenshots/${runId}/`;
}

/**
 * The key of the screenshot of `url` in `runId`. Deterministic (issue
 * #423): a re-render or a resumed crawl overwrites instead of piling up.
 */
export function screenshotKey(runId: string, url: string): string {
  const fragment = createHash("sha256").update(url).digest("hex").slice(0, 16);
  return `${screenshotPrefix(runId)}src-${fragment}.png`;
}

/** A key the job reports must be one the admin made for this run. */
function assertRunKey(runId: string, key: string | undefined): void {
  if (key === undefined) return;
  if (!new RegExp(`^${screenshotPrefix(runId)}src-[0-9a-f]{16}\\.png$`).test(key)) {
    throw new ActionRefusal(`screenshot key ${JSON.stringify(key)} is not one of this run's`);
  }
}

/** Fail the run with `message`, when it is still crawling. */
async function failRun(deps: AdminJobDeps, runId: string, message: string): Promise<void> {
  await op(deps, "imports.fail_crawl", { runId, message: message.slice(0, 2000) });
}

/** Render `input.url` with the install's renderer and keep its screenshot. */
async function render(
  deps: AdminJobDeps,
  runId: string,
  input: RenderRequest,
): Promise<RenderAnswer> {
  const taken = await op<{ state: string; budget: number | null }>(deps, "imports.take_render", {
    runId,
  });
  if (taken.state === "not-crawling") {
    throw new ActionRefusal("the run is not crawling any more; it renders nothing");
  }
  if (taken.state === "over-budget") {
    // A bounded crawl's end, not a fault: the job ends the crawl with the
    // pages it has and records the rest as skipped.
    return {
      ok: false,
      reason: "budget",
      message: `the run used its ${taken.budget} renders (three per page of its page cap, plus 50)`,
    };
  }
  // The renderer guards every URL with the admin's own exemptions (#191):
  // the job cannot widen them.
  const screenshotter = await getExternalScreenshotter({ allowedHosts: importerAllowedHosts() });
  if (!screenshotter) return { ok: false, reason: "unavailable", message: NO_BROWSER };
  let shot: Screenshot;
  try {
    shot = await screenshotter.capture(input.url, {
      external: true,
      sampleStyles: input.sampleStyles,
      captureHtml: input.captureHtml,
    });
  } catch (e) {
    return {
      ok: false,
      reason: isExternalUrlBlockedError(e) ? "blocked" : "failed",
      message: (e instanceof Error ? e.message : String(e)).slice(0, 2000),
    };
  } finally {
    await screenshotter.dispose().catch(() => undefined);
  }
  // issue #198 — the pixels stay here; the job learns the key. A failed
  // store is the page's loud note on the job's side, never a failed crawl.
  const key = screenshotKey(runId, input.url);
  let storeError: string | null = null;
  try {
    await getMediaStorage().put(key, shot.bytes, "image/png");
  } catch (e) {
    storeError = (e instanceof Error ? e.message : String(e)).slice(0, 1000);
  }
  return {
    ok: true,
    key: storeError === null ? key : null,
    storeError,
    width: shot.width,
    height: shot.height,
    ...(shot.finalUrl !== undefined ? { finalUrl: shot.finalUrl } : {}),
    ...(shot.finalStatus !== undefined ? { finalStatus: shot.finalStatus } : {}),
    ...(shot.contentType !== undefined ? { contentType: shot.contentType } : {}),
    ...(shot.styleSamples !== undefined ? { styleSamples: shot.styleSamples } : {}),
    ...(shot.renderedHtml !== undefined ? { renderedHtml: shot.renderedHtml } : {}),
  };
}

/** The site import's kind of reporting job. */
export const siteImportJobKind: ReportingJobKindDef = {
  kind: "site_import",
  label: "site import",
  gcp: {
    jobEnvVar: IMPORT_CRAWL_JOB_ENV_VAR,
    serviceAccountEnvVar: IMPORT_CRAWL_SERVICE_ACCOUNT_ENV_VAR,
  },
  pendingIssue: {
    aws: "issue #749: an ECS task per site import",
    azure: "issue #750: a Container Apps job per site import",
  },
  actions: {
    start: {
      input: z.object({}).strict(),
      async handle(deps, runId) {
        const claimed = await op<{
          state: "claimed" | "settled" | "missing";
          run: {
            sourceUrl: string;
            depth: number;
            maxPages: number;
            explicitUrls: unknown;
            crawlScope: unknown;
            crawlState: unknown;
            crawlRenders: number;
          } | null;
        }>(deps, "imports.claim_crawl", { runId });
        if (claimed.state !== "claimed" || !claimed.run) {
          const reason =
            claimed.state === "missing"
              ? "the import run was deleted"
              : "the crawl has ended already";
          const value: CrawlStart = { kind: "stop", reason };
          return { value, done: { outcome: "stopped", note: reason } };
        }
        const run = claimed.run;
        let urls: string[] | null;
        let scope: ReturnType<typeof parseCrawlScope>;
        try {
          // issue #229 / #425 — a present-but-malformed list or scope fails
          // the run loudly instead of crawling something the Owner did not
          // approve (no fallbacks pre-1.0); only SQL NULL means "none".
          urls = parseExplicitUrls(run.explicitUrls);
          scope = parseCrawlScope(run.crawlScope);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          await failRun(deps, runId, message);
          const value: CrawlStart = { kind: "stop", reason: message };
          return { value, done: { outcome: "completed", note: `the run failed: ${message}` } };
        }
        const value: CrawlStart = {
          kind: "crawl",
          sourceUrl: run.sourceUrl,
          depth: run.depth,
          maxPages: run.maxPages,
          urls,
          scope,
          resumeFrom: parseStoredCheckpoint(run.crawlState),
          allowedHosts: [...importerAllowedHosts()],
          renderBudget: renderBudget(run.maxPages),
          rendersLeft: Math.max(0, renderBudget(run.maxPages) - run.crawlRenders),
        };
        return { value };
      },
    },
    render: {
      input: renderRequestSchema,
      async handle(deps, runId, input: RenderRequest) {
        return { value: await render(deps, runId, input) };
      },
    },
    batch: {
      input: batchReportSchema,
      async handle(deps, runId, input: BatchReport) {
        for (const c of input.captures) assertRunKey(runId, c.screenshotObjectKey);
        const now = await op<{ crawling: boolean }>(deps, "imports.is_crawling", { runId });
        if (!now.crawling) throw new ActionRefusal("the run is not crawling any more");
        await op(deps, "imports.write_extracted_pages", { runId, pages: input.pages });
        try {
          await recordBatchCaptures({
            runId,
            adapter: deps.adapter,
            registry: deps.registry,
            captures: input.captures,
            tokenlessCapturedUrls: input.tokenlessCapturedUrls,
          });
        } catch (e) {
          // A capture naming a page the batch did not write: sending it
          // again changes nothing.
          throw new ActionRefusal(e instanceof Error ? e.message : String(e));
        }
        return { value: { written: input.pages.length } };
      },
    },
    checkpoint: {
      input: crawlCheckpointSchema,
      async handle(deps, runId, input) {
        const r = await op<{ saved: boolean }>(deps, "imports.save_crawl_checkpoint", {
          runId,
          checkpoint: input,
        });
        if (!r.saved) throw new ActionRefusal("the run is not crawling any more");
        return { value: r };
      },
    },
    "capture-targets": {
      input: z.object({}).strict(),
      async handle(deps, runId) {
        const r = await op<{ pages: CaptureTarget[] }>(deps, "imports.list_capture_targets", {
          runId,
          onlyMissingScreenshot: true,
        });
        return { value: r.pages };
      },
    },
    "page-capture": {
      input: pageCaptureSchema,
      async handle(deps, runId, input: z.infer<typeof pageCaptureSchema>) {
        assertRunKey(runId, input.screenshotObjectKey);
        const r = await op<{ updated: boolean }>(deps, "imports.update_page_capture", {
          runId,
          ...input,
        });
        if (!r.updated) {
          throw new ActionRefusal(`page ${input.importPageId} is not one of this crawling run's`);
        }
        return { value: r };
      },
    },
    "page-note": {
      input: pageNoteSchema,
      async handle(deps, runId, input: z.infer<typeof pageNoteSchema>) {
        const r = await op<{ noted: boolean }>(deps, "imports.add_crawl_page_note", {
          runId,
          ...input,
        });
        if (!r.noted) {
          throw new ActionRefusal(`page ${input.importPageId} is not one of this crawling run's`);
        }
        return { value: r };
      },
    },
    finish: {
      input: finishReportSchema,
      async handle(deps, runId, input: FinishReport) {
        // issue #423 — the run-level tokens from ALL pages' samples (the
        // crawl's renders and the second pass), read back from the rows.
        await writeRunDesignTokenAggregate({
          runId,
          adapter: deps.adapter,
          registry: deps.registry,
        });
        const r = await op<{ finished: boolean }>(deps, "imports.finish_crawl", {
          runId,
          pagesSeen: input.pagesSeen,
          pagesExtracted: input.pagesExtracted,
          report: {
            errors: input.errors,
            skipped: input.skipped,
            skippedOutOfScope: input.skippedOutOfScope,
          },
        });
        return {
          value: r,
          done: r.finished
            ? { outcome: "completed" }
            : { outcome: "stopped", note: "the run had left 'crawling' before the crawl finished" },
        };
      },
    },
    fail: {
      input: failReportSchema,
      async handle(deps, runId, input: z.infer<typeof failReportSchema>) {
        await failRun(deps, runId, input.message);
        return {
          value: {},
          done: { outcome: "completed", note: `the crawl failed: ${input.message}` },
        };
      },
    },
  },

  async listUnstarted(deps, limit) {
    const r = await op<{ runIds: string[] }>(deps, "imports.sweep_unstarted_crawls", { limit });
    return r.runIds;
  },

  async giveUp(deps, runId, message) {
    await failRun(deps, runId, message);
  },
};
