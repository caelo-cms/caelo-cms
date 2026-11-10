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
import { type JobReporter, JobStoppedError, ReportError } from "../reporting-jobs/job-reporter.js";
import { compactCheckpoint } from "./crawl-checkpoint.js";
import {
  batchCaptures,
  captureMissingGroundTruth,
  type GroundTruthSink,
  type KeyedScreenshotter,
  type PageCapture,
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
 * The crawl has stopped (it failed, gave its attempt back, or the admin
 * ended it): what its other workers still ask for fails at once. Coded as
 * the SSRF guard's refusal so the crawler does not fall back to fetching
 * the page itself; the workers then drain their queue without a request.
 */
function haltedError(): Error {
  return Object.assign(new Error("the crawl has stopped"), { code: EXTERNAL_URL_BLOCKED });
}

/**
 * The admin's renderer, as the crawler sees a screenshotter: `capture` asks
 * the admin to render and store the page. Only captures are asked for;
 * after the admin said it has no renderer, no page asks again.
 *
 * @param halted - true once the crawl has stopped (see {@link haltedError}).
 */
export function reportedScreenshotter(
  reporter: JobReporter,
  halted: () => boolean = () => reporter.stopped,
): KeyedScreenshotter {
  const keys = new WeakMap<Screenshot, { key: string | null; error: string | null }>();
  let unavailable: string | null = null;
  const notForTheCrawl = async (): Promise<never> => {
    throw new Error("the crawl asks the admin for captures only");
  };
  return {
    async capture(url, opts) {
      if (halted()) throw haltedError();
      if (unavailable !== null) throw new RendererUnavailableError(unavailable);
      const answer = await reporter.call<RenderAnswer>("render", {
        url,
        sampleStyles: opts?.sampleStyles === true,
        captureHtml: opts?.captureHtml === true,
      });
      if (!answer.ok) {
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

/** A fault that another attempt may not meet: the admin was not reached, or was busy. */
function isPassingFault(e: unknown): boolean {
  return e instanceof ReportError && (e.status === 0 || e.status === 429 || e.status >= 500);
}

function describe(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 1000) || "the crawl failed";
}

async function crawl(
  reporter: JobReporter,
  start: Extract<CrawlStart, { kind: "crawl" }>,
  deps: CrawlJobDeps,
  halted: () => boolean,
): Promise<void> {
  const screenshotter = reportedScreenshotter(reporter, halted);
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
    onBatch: async (pages) => {
      if (halted()) throw haltedError();
      const { captures, tokenlessCapturedUrls } = batchCaptures(pages, keyByUrl);
      for (const p of pages) keyByUrl.delete(p.url);
      await reporter.call("batch", {
        pages: pages.map(pageRow),
        captures,
        tokenlessCapturedUrls,
      } satisfies BatchReport);
    },
    onCheckpoint: async (cp: CrawlCheckpoint) => {
      if (halted()) throw haltedError();
      await reporter.call("checkpoint", compactCheckpoint(cp));
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
  // The crawler's other workers outlive a failure of one of them (it does
  // not cancel them): once this attempt stops, they must not go on.
  let stopped = false;
  const halted = () => stopped || reporter.stopped;
  try {
    await crawl(reporter, start, deps, halted);
  } catch (e) {
    stopped = true;
    if (e instanceof JobStoppedError) throw e;
    if (isPassingFault(e)) {
      // Give the attempt back with the reason; the next one resumes from
      // the checkpoint. When even this report fails, the lease runs out.
      await reporter.call("defer", { reason: describe(e) }).catch(() => undefined);
      throw e;
    }
    await reporter.call("fail", { message: describe(e) });
  }
}
