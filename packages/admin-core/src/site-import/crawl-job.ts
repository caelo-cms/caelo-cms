// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1360 — the site import's crawl as a reporting job (#1140 category
 * A): the job's side. One attempt takes the run the admin started it for,
 * crawls it, and reports everything it finds; the admin renders the pages
 * it asks for and records the reports (import-job-kind.ts). It replaces the
 * admin's 10-second crawl loop, so the admin only works inside requests
 * (CLAUDE.md §11.B Tier 5).
 *
 * Where each step runs:
 *
 *   - the crawl loop, robots.txt, sitemaps, link discovery and extraction:
 *     here. Every fetch of its own goes through the SSRF guard
 *     (site-importer safe-fetch.ts) with the admin's exemptions; the job
 *     runs no browser and executes nothing it fetches;
 *   - each page's render: the admin's renderer (the capture job on Google
 *     Cloud, the one shared browser on a self-hosted admin), asked with a
 *     `render` report. The admin keeps the screenshot and hands back the
 *     HTML and the style samples, so the pixels never travel twice;
 *   - every write: the admin, through the Query API.
 *
 * Resume: after each batch the job reports the frontier (compacted); a new
 * attempt (the tick's backstop restarts one whose job died) resumes there.
 * A crawl that cannot go on (its source is blocked, the admin refuses a
 * report for good) reports `fail`, and the run fails with the reason; a
 * passing fault (the admin unreachable past the reporter's retries) gives
 * the attempt back, and the next one resumes from the checkpoint.
 */

import {
  type CrawlCheckpoint,
  type CrawledPage,
  type CrawlOptions,
  crawlSite,
  EXTERNAL_URL_BLOCKED,
  type Screenshot,
} from "@caelo-cms/site-importer";
import {
  deferAttempt,
  isPassingReportFault,
  type JobReporter,
  JobStoppedError,
} from "../reporting-jobs/job-reporter.js";
import { compactCheckpoint } from "./crawl-checkpoint.js";
import {
  batchCaptures,
  CrawlHaltedError,
  captureMissingGroundTruth,
  type GroundTruthSink,
  type KeyedScreenshotter,
  type PageCapture,
  RenderBudgetSpentError,
  RendererUnavailableError,
} from "./ground-truth.js";
import type {
  BatchReport,
  CaptureTarget,
  CrawlStart,
  FinishReport,
  RenderAnswer,
} from "./import-job-wire.js";

/** Test seams: a hermetic crawl without a network. */
export interface CrawlJobDeps {
  readonly fetcher?: CrawlOptions["fetcher"];
  readonly textFetcher?: CrawlOptions["textFetcher"];
  readonly throttleMs?: number;
}

/**
 * One attempt's stop: once set, the crawler's other workers (it does not
 * cancel them when one fails) ask for nothing more, and `cause` is what
 * stopped it.
 */
export interface CrawlAttempt {
  stopped: boolean;
  /** The first report failure that stopped it, also one the crawler swallowed. */
  cause: unknown;
  /**
   * Aborted when the attempt stops: the crawler takes no next URL and waits
   * out no throttle, so a stopped attempt does not walk its whole frontier
   * before it is given back (#1360 review).
   */
  readonly abort: AbortController;
  /** Renders the run may still ask for (`start`'s `rendersLeft`). */
  rendersLeft: number;
  /** Why the crawl ends early: its render budget, once spent. */
  budgetSpent: string | null;
  /** What `budgetSpent` says once the budget runs out. */
  readonly budgetMessage: string;
}

/**
 * The admin's renderer, as the crawler sees a screenshotter: `capture` asks
 * the admin to render and store the page. Only captures are asked for;
 * after the admin said it has no renderer, no page asks again.
 *
 * A render the admin could not be asked for (unreachable, busy, refused)
 * stops the attempt instead of failing one page: the crawler would fetch
 * the page statically instead and keep a page without its JavaScript-built
 * content. The attempt is given back or failed with that cause.
 */
export function reportedScreenshotter(
  reporter: JobReporter,
  attempt: CrawlAttempt = {
    stopped: false,
    cause: null,
    abort: new AbortController(),
    rendersLeft: Number.POSITIVE_INFINITY,
    budgetSpent: null,
    budgetMessage: "the run used its render budget",
  },
): KeyedScreenshotter {
  const keys = new WeakMap<Screenshot, { key: string | null; error: string | null }>();
  let unavailable: string | null = null;
  const notForTheCrawl = async (): Promise<never> => {
    throw new Error("the crawl asks the admin for captures only");
  };
  return {
    async capture(url, opts) {
      if (attempt.stopped || reporter.stopped) throw new CrawlHaltedError();
      if (unavailable !== null) throw new RendererUnavailableError(unavailable);
      // The run's render budget bounds the crawl (#1360): a page past it is
      // skipped, and the crawl ends with what it has.
      if (attempt.budgetSpent !== null) throw new RenderBudgetSpentError(attempt.budgetSpent);
      if (attempt.rendersLeft <= 0) {
        attempt.budgetSpent = attempt.budgetMessage;
        throw new RenderBudgetSpentError(attempt.budgetSpent);
      }
      attempt.rendersLeft -= 1;
      let answer: RenderAnswer;
      try {
        answer = await reporter.call<RenderAnswer>("render", {
          url,
          sampleStyles: opts?.sampleStyles === true,
          captureHtml: opts?.captureHtml === true,
        });
      } catch (e) {
        haltAttempt(attempt, e);
        throw new CrawlHaltedError();
      }
      if (!answer.ok) {
        if (answer.reason === "budget") {
          attempt.rendersLeft = 0;
          attempt.budgetSpent = answer.message;
          throw new RenderBudgetSpentError(answer.message);
        }
        if (answer.reason === "unavailable") {
          unavailable = answer.message;
          throw new RendererUnavailableError(answer.message);
        }
        // Recognisable as the SSRF guard's refusal (`isExternalUrlBlockedError`),
        // so the crawl stops on a blocked source instead of fetching it statically.
        throw answer.reason === "blocked"
          ? Object.assign(new Error(answer.message), { code: EXTERNAL_URL_BLOCKED })
          : new Error(answer.message);
      }
      const shot: Screenshot = {
        // The pixels stay with the admin; `stored` says where.
        bytes: new Uint8Array(0),
        width: answer.width,
        height: answer.height,
        ...(answer.finalUrl !== undefined ? { finalUrl: answer.finalUrl } : {}),
        ...(answer.finalStatus !== undefined ? { finalStatus: answer.finalStatus } : {}),
        ...(answer.contentType !== undefined ? { contentType: answer.contentType } : {}),
        ...(answer.styleSamples !== undefined ? { styleSamples: answer.styleSamples } : {}),
        ...(answer.renderedHtml !== undefined ? { renderedHtml: answer.renderedHtml } : {}),
      };
      keys.set(shot, { key: answer.key, error: answer.storeError });
      return shot;
    },
    renderHtml: notForTheCrawl,
    query: notForTheCrawl,
    async dispose() {},
    stored(shot) {
      return keys.get(shot) ?? { key: null, error: "this capture was not rendered by the admin" };
    },
  };
}

/** The second pass's sink: the job's reports. */
export function reportedGroundTruthSink(reporter: JobReporter): GroundTruthSink {
  return {
    targets: () => reporter.call<CaptureTarget[]>("capture-targets"),
    async note(importPageId, category, note) {
      await reporter.call("page-note", { importPageId, category, note: note.slice(0, 1000) });
    },
    async record(importPageId, capture: PageCapture) {
      await reporter.call("page-capture", { importPageId, ...capture });
    },
  };
}

/** An extracted page as the admin stores it (`imports.write_extracted_pages`). */
function pageRow(p: CrawledPage): BatchReport["pages"][number] {
  return {
    // issue #425 — `p.url` is the FINAL post-redirect URL; the requested
    // URL rides along as provenance when they differ.
    sourceUrl: p.url,
    ...(p.requestedUrl !== undefined ? { requestedUrl: p.requestedUrl } : {}),
    proposedSlug: p.proposedSlug,
    proposedTitle: p.title.slice(0, 500),
    // Bounded like every stored crawl field; the AI shortens it to the
    // 160-character target when it carries it over anyway.
    sourceMetaDescription: p.metaDescription.slice(0, 2000),
    proposedModules: p.modules.map((m) => ({
      blockName: m.blockName,
      position: m.position,
      html: m.html,
      displayName: m.displayName,
    })),
    proposedThemeTokens: p.themeTokens,
    signature: p.signature,
    pageCss: p.pageCss,
    // run #10 D3 — the extractor's comment-thread stripper count, kept as
    // a visible `comments-stripped:<n>` note on the import page.
    commentsStripped: p.commentsStripped,
  };
}

/** Stops the attempt: keeps the first cause and tells the crawler. */
function haltAttempt(attempt: CrawlAttempt, cause: unknown): void {
  if (attempt.cause === null) attempt.cause = cause;
  attempt.stopped = true;
  if (!attempt.abort.signal.aborted) attempt.abort.abort(new CrawlHaltedError());
}

/** A report of the crawl's own: when it fails, the attempt stops at once. */
async function reportOrHalt<T>(attempt: CrawlAttempt, send: () => Promise<T>): Promise<T> {
  try {
    return await send();
  } catch (e) {
    haltAttempt(attempt, e);
    throw e;
  }
}

function describe(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 1000) || "the crawl failed";
}

async function crawl(
  reporter: JobReporter,
  start: Extract<CrawlStart, { kind: "crawl" }>,
  deps: CrawlJobDeps,
  attempt: CrawlAttempt,
): Promise<void> {
  const screenshotter = reportedScreenshotter(reporter, attempt);
  const halted = () => attempt.stopped || reporter.stopped;
  // issue #423 — the render already stored each page's screenshot; the
  // crawl remembers only where, keyed by the page's final URL.
  const keyByUrl = new Map<string, string>();
  const onPageCapture = async ({ url, screenshot }: { url: string; screenshot: Screenshot }) => {
    const stored = screenshotter.stored(screenshot);
    // Thrown, the crawler records it in the run's errors and the page stays
    // keyless, so the second pass renders it again and notes it.
    if (!stored.key) throw new Error(stored.error ?? "the admin stored no screenshot");
    keyByUrl.set(url, stored.key);
  };
  const result = await crawlSite({
    sourceUrl: start.sourceUrl,
    depth: start.depth,
    maxPages: start.maxPages,
    ...(start.urls ? { urls: start.urls } : {}),
    ...(start.scope ? { scope: start.scope } : {}),
    throttleMs: deps.throttleMs ?? 100,
    allowedHosts: start.allowedHosts,
    screenshotter,
    ...(deps.fetcher ? { fetcher: deps.fetcher } : {}),
    ...(deps.textFetcher ? { textFetcher: deps.textFetcher } : {}),
    ...(start.resumeFrom ? { resumeFrom: start.resumeFrom } : {}),
    onPageCapture,
    // A spent render budget ends the crawl as a bounded result: the pages
    // it has, and every URL left in the skip ledger with the reason.
    stopWhen: () => attempt.budgetSpent,
    signal: attempt.abort.signal,
    onBatch: async (pages) => {
      if (halted()) throw new CrawlHaltedError();
      const { captures, tokenlessCapturedUrls } = batchCaptures(pages, keyByUrl);
      for (const p of pages) keyByUrl.delete(p.url);
      await reportOrHalt(attempt, () =>
        reporter.call("batch", {
          pages: pages.map(pageRow),
          captures,
          tokenlessCapturedUrls,
        } satisfies BatchReport),
      );
    },
    onCheckpoint: async (cp: CrawlCheckpoint) => {
      if (halted()) throw new CrawlHaltedError();
      await reportOrHalt(attempt, () => reporter.call("checkpoint", compactCheckpoint(cp)));
    },
  });
  // issue #247 (WS1), #423 — the pages still without a screenshot get one
  // more render each, or a loud note.
  await captureMissingGroundTruth(reportedGroundTruthSink(reporter), screenshotter);
  await reporter.call("finish", {
    pagesSeen: result.seenCount,
    pagesExtracted: result.pagesCrawled,
    errors: [...result.errors],
    skipped: [...result.skipped],
    skippedOutOfScope: result.skippedOutOfScope,
  } satisfies FinishReport);
}

/** One attempt of a site import's crawl (see the file comment). */
export async function runSiteImportJob(
  reporter: JobReporter,
  deps: CrawlJobDeps = {},
): Promise<void> {
  const start = await reporter.call<CrawlStart>("start");
  if (start.kind === "stop") {
    console.log(`[site-import-job] ${reporter.subjectId}: nothing to crawl (${start.reason})`);
    return;
  }
  const budgetMessage = `the run used its ${start.renderBudget} renders (three per page of its page cap, plus 50)`;
  const attempt: CrawlAttempt = {
    stopped: false,
    cause: null,
    abort: new AbortController(),
    rendersLeft: start.rendersLeft,
    budgetSpent: start.rendersLeft > 0 ? null : budgetMessage,
    budgetMessage,
  };
  let error: unknown = null;
  try {
    await crawl(reporter, start, deps, attempt);
  } catch (e) {
    error = e;
  }
  if (error === null && attempt.cause === null) return;
  // Stops the crawler's workers still running (it does not cancel them
  // when one fails). What stopped the attempt: a report failure the crawler
  // swallowed comes first, the halt it caused in the other workers after.
  haltAttempt(attempt, error);
  const cause = attempt.cause;
  if (cause instanceof JobStoppedError) throw cause;
  if (isPassingReportFault(cause)) {
    // Give the attempt back with the reason; the next one resumes from the
    // checkpoint. When even this report fails, the lease runs out.
    await deferAttempt(reporter, describe(cause));
  }
  await reporter.call("fail", { message: describe(cause) });
}
