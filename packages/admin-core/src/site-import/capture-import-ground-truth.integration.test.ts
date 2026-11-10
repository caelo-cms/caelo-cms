// SPDX-License-Identifier: MPL-2.0

/**
 * issue #247 (WS1), #423, #1360 — the site import's design ground truth as
 * the crawl's job reports it: the second pass renders every page still
 * without a screenshot (one retry) and the admin stores the pixels; every
 * page that ends up without stored ground truth carries a LOUD
 * `screenshot_missing` / `design_tokens_missing` note (no silent skips, the
 * F9 regression class). The batch report lands the crawl's own captures in
 * one bulk write. Also keeps the #198 persistence coverage.
 *
 * Real Postgres ops behind the real report dispatch (an in-process reporter
 * of a started `site_import` job); the admin's renderer and media storage
 * are injected fakes — Chromium has no place in an integration lane.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext, MediaStorageAdapter } from "@caelo-cms/shared";
import {
  deriveDesignTokens,
  type ElementStyleSample,
  type Screenshot,
  type Screenshotter,
} from "@caelo-cms/site-importer";
import { setExternalScreenshotterForTests } from "../ai/tools/_external-screenshotter.js";
import { setMediaStorage } from "../media/storage.js";
import { registerAdminOps } from "../register.js";
import { inProcessReportTransport } from "../reporting-jobs/in-process.js";
import {
  createJobReporter,
  type JobReporter,
  ReportError,
} from "../reporting-jobs/job-reporter.js";
import { startReportingJob } from "../reporting-jobs/launcher.js";
import type { JobOrder } from "../reporting-jobs/protocol.js";
import { reportedGroundTruthSink, reportedScreenshotter } from "./crawl-job.js";
import { captureMissingGroundTruth, writeRunDesignTokenAggregate } from "./ground-truth.js";
import { screenshotKey } from "./import-job-kind.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
const ADMIN = () => ({ adapter, registry });

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "issue247-ground-truth",
};

/** The admin's media storage, in memory; `failing` makes every put throw. */
function memoryMedia(failing = false): MediaStorageAdapter & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  const get = async (key: string) => {
    const o = objects.get(key);
    if (!o) throw new Error(`no object ${key}`);
    return o;
  };
  return {
    objects,
    async put(key, body) {
      if (failing) throw new Error("bucket offline");
      objects.set(key, body);
    },
    get,
    size: async (key) => (await get(key)).byteLength,
    async openStream(key) {
      const body = await get(key);
      return { body: new Blob([body]).stream(), sizeBytes: body.byteLength };
    },
    async delete(key) {
      objects.delete(key);
    },
    exists: async (key) => objects.has(key),
    totalSizeBytes: async () => [...objects.values()].reduce((n, o) => n + o.byteLength, 0),
  };
}

let media = memoryMedia();

beforeAll(() => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

beforeEach(() => {
  media = memoryMedia();
  setMediaStorage(media);
});

afterEach(() => {
  setExternalScreenshotterForTests(null);
});

afterAll(async () => {
  setExternalScreenshotterForTests(null);
  await adapter.close();
});

const SAMPLES: ElementStyleSample[] = [
  {
    role: "body",
    styles: {
      color: "rgb(17, 17, 17)",
      backgroundColor: "rgb(255, 255, 255)",
      fontFamily: "Inter, sans-serif",
      fontSize: "16px",
    },
  },
  { role: "a", styles: { color: "rgb(0, 102, 204)" } },
  {
    role: "button",
    styles: {
      color: "rgb(255, 255, 255)",
      backgroundColor: "rgb(220, 38, 38)",
      borderRadius: "8px",
    },
  },
];

const shot = (fill: number, styleSamples?: ElementStyleSample[]): Screenshot => ({
  bytes: new Uint8Array(64).fill(fill),
  width: 8,
  height: 2,
  ...(styleSamples ? { styleSamples } : {}),
});

/** The admin's renderer: `capture` as given, nothing else. */
function renderer(capture: Screenshotter["capture"]): void {
  const s: Screenshotter = {
    capture,
    renderHtml: async () => {
      throw new Error("the crawl renders with capture only");
    },
    query: async () => {
      throw new Error("the crawl renders with capture only");
    },
    async dispose() {},
  };
  setExternalScreenshotterForTests(async () => s);
}

/** A crawling run with these pages, as the crawl's batches leave it. */
async function makeRun(sourceUrl: string, pageUrls: string[]): Promise<string> {
  const run = await execute(registry, adapter, SYSTEM, "imports.create_run", {
    sourceUrl,
    depth: 1,
    maxPages: 5,
  });
  if (!run.ok) throw new Error(JSON.stringify(run.error));
  const runId = (run.value as { runId: string }).runId;
  if (pageUrls.length === 0) return runId;
  const wrote = await execute(registry, adapter, SYSTEM, "imports.write_extracted_pages", {
    runId,
    pages: pageUrls.map((u, i) => ({
      sourceUrl: u,
      proposedSlug: i === 0 ? "home" : `page-${i}`,
      proposedTitle: `Page ${i}`,
      proposedModules: [],
      proposedThemeTokens: {},
      signature: i === 0 ? "home" : `sig-${i}`,
    })),
  });
  if (!wrote.ok) throw new Error(JSON.stringify(wrote.error));
  return runId;
}

/** The reporter of a freshly started attempt of the run's crawl job. */
async function reporterFor(runId: string): Promise<JobReporter> {
  const orders: JobOrder[] = [];
  const parked = {
    label: "the test",
    launch: async (order: JobOrder) => {
      orders.push(order);
      return "test-execution";
    },
  };
  expect(
    (await startReportingJob(ADMIN(), "site_import", runId, { launcher: parked })).outcome,
  ).toBe("started");
  const order = orders[0] as JobOrder;
  return createJobReporter(order, inProcessReportTransport(ADMIN(), order));
}

/** The second pass, through the job's reports. */
async function secondPass(runId: string) {
  const reporter = await reporterFor(runId);
  return captureMissingGroundTruth(
    reportedGroundTruthSink(reporter),
    reportedScreenshotter(reporter),
  );
}

interface ReportShape {
  pagesMissingScreenshot: number;
  // issue #423 — capture ledger (captured / failed-with-note / skipped).
  captureStats: { captured: number; failed: number; skipped: number };
  siteDesignTokens: unknown;
  notes: { category: string; suggested: number }[];
}

async function report(runId: string): Promise<ReportShape> {
  const r = await execute(registry, adapter, SYSTEM, "imports.get_run_report", { runId });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value as ReportShape;
}

interface PageRow {
  id: string;
  sourceUrl: string;
  screenshotObjectKey: string | null;
  sampledDesignTokens: {
    palette: { value: string; count: number }[];
    roles: Record<string, Record<string, string>>;
  } | null;
}

async function pagesOf(runId: string): Promise<PageRow[]> {
  const got = await execute(registry, adapter, SYSTEM, "imports.get", { runId });
  if (!got.ok) throw new Error(JSON.stringify(got.error));
  return (got.value as { pages: PageRow[] }).pages;
}

describe("the second pass, reported by the crawl's job (#247, #1360; keeps #198 persistence)", () => {
  it("stores the screenshot under the run's prefix, the page's sampled tokens and, at the end, the run's aggregate", async () => {
    const url = "https://issue247.example/";
    const runId = await makeRun(url, [url]);
    renderer(async (_url, opts) => shot(1, opts?.sampleStyles ? SAMPLES : undefined));
    const result = await secondPass(runId);
    expect(result).toEqual({ captured: 1, failed: 0 });

    const [page] = await pagesOf(runId);
    if (!page) throw new Error("page missing");
    expect(page.screenshotObjectKey).toBe(screenshotKey(runId, url));
    expect(page.screenshotObjectKey?.startsWith(`import-screenshots/${runId}/src-`)).toBe(true);
    // The pixels landed in the admin's storage, never in the job.
    expect(media.objects.get(page.screenshotObjectKey ?? "")?.[0]).toBe(1);
    expect(page.sampledDesignTokens?.roles.body?.backgroundColor).toBe("#ffffff");
    expect(page.sampledDesignTokens?.roles.button?.backgroundColor).toBe("#dc2626");

    // The run's aggregate is the admin's, from row state (the finish report).
    await writeRunDesignTokenAggregate({ runId, adapter, registry });
    const rep = await report(runId);
    expect(rep.pagesMissingScreenshot).toBe(0);
    const site = rep.siteDesignTokens as {
      pageCount: number;
      roles: Record<string, Record<string, string>>;
    };
    expect(site.pageCount).toBe(1);
    expect(site.roles.body?.color).toBe("#111111");
  });

  it("retries a transient render failure once, without a note", async () => {
    const url = "https://issue247-retry.example/";
    const runId = await makeRun(url, [url]);
    let attempts = 0;
    renderer(async (_url, opts) => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient network blip");
      return shot(1, opts?.sampleStyles ? SAMPLES : undefined);
    });
    expect((await secondPass(runId)).captured).toBe(1);
    expect(attempts).toBe(2);
    const rep = await report(runId);
    expect(rep.pagesMissingScreenshot).toBe(0);
    expect(rep.notes.find((n) => n.category === "screenshot_missing")).toBeUndefined();
  });

  it("a persistently failing render records a screenshot_missing note and leaves the page UNVERIFIED", async () => {
    const url = "https://issue247-dead.example/";
    const runId = await makeRun(url, [url]);
    renderer(async () => {
      throw new Error("net::ERR_NAME_NOT_RESOLVED");
    });
    expect(await secondPass(runId)).toEqual({ captured: 0, failed: 1 });
    const [page] = await pagesOf(runId);
    expect(page?.screenshotObjectKey).toBeNull();
    const rep = await report(runId);
    expect(rep.pagesMissingScreenshot).toBe(1);
    expect(rep.notes.find((n) => n.category === "screenshot_missing")?.suggested).toBe(1);
  });

  it("an install without a renderer notes EVERY page, asking the admin once (F9)", async () => {
    const home = "https://issue247-nopw.example/";
    const runId = await makeRun(home, [home, `${home}about`]);
    let asked = 0;
    setExternalScreenshotterForTests(async () => {
      asked += 1;
      return null;
    });
    expect(await secondPass(runId)).toEqual({ captured: 0, failed: 2 });
    expect(asked).toBe(1);
    const rep = await report(runId);
    expect(rep.pagesMissingScreenshot).toBe(2);
    expect(rep.notes.find((n) => n.category === "screenshot_missing")?.suggested).toBe(2);
  });

  it("a failing store degrades to a NULL key plus a loud note; the tokens still land", async () => {
    media = memoryMedia(true);
    setMediaStorage(media);
    const url = "https://issue247-dark.example/";
    const runId = await makeRun(url, [url]);
    renderer(async (_url, opts) => shot(1, opts?.sampleStyles ? SAMPLES : undefined));
    expect((await secondPass(runId)).captured).toBe(1);
    const [page] = await pagesOf(runId);
    expect(page?.screenshotObjectKey).toBeNull();
    expect(page?.sampledDesignTokens).not.toBeNull();
    const rep = await report(runId);
    expect(rep.pagesMissingScreenshot).toBe(1);
    expect(rep.notes.find((n) => n.category === "screenshot_missing")?.suggested).toBe(1);
  });
});

/** One extracted page as the crawl's batch report carries it. */
function row(url: string, slug: string) {
  return {
    sourceUrl: url,
    proposedSlug: slug,
    proposedTitle: slug,
    proposedModules: [],
    proposedThemeTokens: {},
    signature: slug,
    pageCss: "",
    commentsStripped: 0,
  };
}

describe("the crawl's batch report and the scoped second pass (#423, #1360)", () => {
  it("lands the batch's pages, keys and tokens in one report and notes its sampleless pages", async () => {
    const home = "https://issue423-batch.example/";
    const about = "https://issue423-batch.example/about";
    const runId = await makeRun(home, []);
    const reporter = await reporterFor(runId);
    const tokens = deriveDesignTokens(SAMPLES);
    await reporter.call("batch", {
      pages: [row(home, "home"), row(about, "about")],
      captures: [
        {
          sourceUrl: home,
          screenshotObjectKey: screenshotKey(runId, home),
          sampledDesignTokens: tokens,
        },
        { sourceUrl: about, screenshotObjectKey: screenshotKey(runId, about) },
      ],
      // `about` rendered but gave no samples: the scoped second pass skips
      // keyed pages and would never note it.
      tokenlessCapturedUrls: [about],
    });

    const pages = await pagesOf(runId);
    const homePage = pages.find((p) => p.sourceUrl === home);
    const aboutPage = pages.find((p) => p.sourceUrl === about);
    expect(homePage?.screenshotObjectKey).toBe(screenshotKey(runId, home));
    expect(homePage?.sampledDesignTokens).not.toBeNull();
    expect(aboutPage?.screenshotObjectKey).toBe(screenshotKey(runId, about));
    expect(aboutPage?.sampledDesignTokens).toBeNull();

    const rep = await report(runId);
    expect(rep.captureStats).toEqual({ captured: 2, failed: 0, skipped: 0 });
    expect(rep.notes.find((n) => n.category === "design_tokens_missing")?.suggested).toBe(1);
    expect(rep.siteDesignTokens).toBeNull();
    await writeRunDesignTokenAggregate({ runId, adapter, registry });
    expect(((await report(runId)).siteDesignTokens as { pageCount: number }).pageCount).toBe(1);
  });

  it("refuses LOUDLY a capture that matches no page of the batch, and a key outside the run", async () => {
    const home = "https://issue423-unmatched.example/";
    const runId = await makeRun(home, []);
    const reporter = await reporterFor(runId);
    const ghost = "https://issue423-unmatched.example/ghost";
    const unmatched = reporter.call("batch", {
      pages: [row(home, "home")],
      captures: [{ sourceUrl: ghost, screenshotObjectKey: screenshotKey(runId, ghost) }],
      tokenlessCapturedUrls: [],
    });
    await expect(unmatched).rejects.toBeInstanceOf(ReportError);
    await expect(unmatched).rejects.toThrow("matched no import_pages row");

    const otherRun = "00000000-0000-4000-8000-000000001360";
    const foreign = reporter.call("batch", {
      pages: [row(home, "home")],
      captures: [{ sourceUrl: home, screenshotObjectKey: screenshotKey(otherRun, home) }],
      tokenlessCapturedUrls: [],
    });
    await expect(foreign).rejects.toThrow("is not one of this run's");
  });

  it("the scoped pass renders only the keyless pages; the admin aggregates over all of them", async () => {
    const home = "https://issue423-scoped.example/";
    const about = "https://issue423-scoped.example/about";
    const runId = await makeRun(home, [home, about]);
    const reporter = await reporterFor(runId);
    const tokens = deriveDesignTokens(SAMPLES);
    // The crawl's own render stored the home page's screenshot only.
    await reporter.call("batch", {
      pages: [row(home, "home")],
      captures: [
        {
          sourceUrl: home,
          screenshotObjectKey: screenshotKey(runId, home),
          sampledDesignTokens: tokens,
        },
      ],
      tokenlessCapturedUrls: [],
    });
    const rendered: string[] = [];
    renderer(async (url, opts) => {
      rendered.push(url);
      return shot(2, opts?.sampleStyles ? SAMPLES : undefined);
    });
    const result = await captureMissingGroundTruth(
      reportedGroundTruthSink(reporter),
      reportedScreenshotter(reporter),
    );
    expect(rendered).toEqual([about]);
    expect(result).toEqual({ captured: 1, failed: 0 });
    const aboutPage = (await pagesOf(runId)).find((p) => p.sourceUrl === about);
    expect(aboutPage?.screenshotObjectKey).toBe(screenshotKey(runId, about));

    let rep = await report(runId);
    expect(rep.siteDesignTokens).toBeNull();
    await writeRunDesignTokenAggregate({ runId, adapter, registry });
    rep = await report(runId);
    expect((rep.siteDesignTokens as { pageCount: number }).pageCount).toBe(2);
    expect(rep.captureStats).toEqual({ captured: 2, failed: 0, skipped: 0 });
  });

  it("with nothing missing, the second pass renders nothing", async () => {
    const home = "https://issue423-done.example/";
    const runId = await makeRun(home, []);
    const reporter = await reporterFor(runId);
    await reporter.call("batch", {
      pages: [row(home, "home")],
      captures: [{ sourceUrl: home, screenshotObjectKey: screenshotKey(runId, home) }],
      tokenlessCapturedUrls: [home],
    });
    let calls = 0;
    renderer(async () => {
      calls += 1;
      throw new Error("should not be called");
    });
    const result = await captureMissingGroundTruth(
      reportedGroundTruthSink(reporter),
      reportedScreenshotter(reporter),
    );
    expect(calls).toBe(0);
    expect(result).toEqual({ captured: 0, failed: 0 });
  });

  it("captureStats: keyless and unnoted counts as skipped (the silent-degradation signal), noted as failed", async () => {
    const home = "https://issue423-stats.example/";
    const runId = await makeRun(home, [home, `${home}about`]);
    let rep = await report(runId);
    expect(rep.captureStats).toEqual({ captured: 0, failed: 0, skipped: 2 });
    renderer(async () => {
      throw new Error("net::ERR_NAME_NOT_RESOLVED");
    });
    await secondPass(runId);
    rep = await report(runId);
    expect(rep.captureStats).toEqual({ captured: 0, failed: 2, skipped: 0 });
  });
});
