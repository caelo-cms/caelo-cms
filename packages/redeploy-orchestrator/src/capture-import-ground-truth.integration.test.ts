// SPDX-License-Identifier: MPL-2.0

/**
 * issue #247 (WS1) — captureImportGroundTruth is the always-on design
 * ground-truth pass: source screenshot + computed-style token sampling
 * in one render session, and a LOUD `screenshot_missing` /
 * `design_tokens_missing` note wherever a page ends up without stored
 * ground truth (no silent skips — F9 regression class). Also keeps the
 * #198 persistence coverage. Real Postgres ops (admin-core is a
 * devDependency for exactly this); screenshotter and storage are
 * injected fakes — Chromium has no place in a unit lane.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { registerAdminOps } from "@caelo-cms/admin-core";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import type {
  CrawledPage,
  ElementStyleSample,
  Screenshot,
  Screenshotter,
} from "@caelo-cms/site-importer";
import {
  captureImportGroundTruth,
  persistBatchCapture,
  writeRunDesignTokenAggregate,
} from "./index.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "issue247-ground-truth",
};

beforeAll(() => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

afterAll(async () => {
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

/** Source captures return samples when asked. */
function fakeScreenshotter(): Screenshotter {
  return {
    async capture(_url, opts) {
      return shot(1, opts?.sampleStyles ? SAMPLES : undefined);
    },
    async dispose() {},
  };
}

async function makeRun(sourceUrl: string, pageUrls: string[]): Promise<string> {
  const run = await execute(registry, adapter, SYSTEM, "imports.create_run", {
    sourceUrl,
    depth: 1,
    maxPages: 5,
  });
  if (!run.ok) throw new Error(JSON.stringify(run.error));
  const runId = (run.value as { runId: string }).runId;
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

describe("captureImportGroundTruth (#247, keeps #198 persistence)", () => {
  it("stores screenshot keys, per-page sampled tokens and the run-level aggregate", async () => {
    const runId = await makeRun("https://issue247.example/", ["https://issue247.example/"]);
    const stored = new Map<string, Uint8Array>();
    const result = await captureImportGroundTruth({
      runId,
      adapter,
      registry,
      screenshotter: fakeScreenshotter(),
      screenshotStorage: {
        async put(key, body) {
          stored.set(key, body);
        },
      },
    });
    expect(result.captured).toBe(1);
    expect(result.failed).toBe(0);

    const got = await execute(registry, adapter, SYSTEM, "imports.get", { runId });
    if (!got.ok) throw new Error(JSON.stringify(got.error));
    const page = (
      got.value as {
        pages: {
          id: string;
          screenshotObjectKey: string | null;
          sampledDesignTokens: {
            palette: { value: string; count: number }[];
            roles: Record<string, Record<string, string>>;
          } | null;
        }[];
      }
    ).pages[0];
    if (!page) throw new Error("page missing");
    expect(page.screenshotObjectKey).toBe(`import-screenshots/${runId}/${page.id}-source.png`);
    // The source object actually landed, with the right bytes.
    expect(stored.get(page.screenshotObjectKey ?? "")?.[0]).toBe(1);

    // issue #247 — computed-style ground truth landed on the page…
    expect(page.sampledDesignTokens).not.toBeNull();
    expect(page.sampledDesignTokens?.roles.body?.backgroundColor).toBe("#ffffff");
    expect(page.sampledDesignTokens?.roles.button?.backgroundColor).toBe("#dc2626");
    // …and aggregated onto the run.
    const rep = await report(runId);
    expect(rep.pagesMissingScreenshot).toBe(0);
    const site = rep.siteDesignTokens as {
      pageCount: number;
      roles: Record<string, Record<string, string>>;
    };
    expect(site.pageCount).toBe(1);
    expect(site.roles.body?.color).toBe("#111111");
  });

  it("retries a transient capture failure once, without a note", async () => {
    const runId = await makeRun("https://issue247-retry.example/", [
      "https://issue247-retry.example/",
    ]);
    let sourceAttempts = 0;
    const flaky: Screenshotter = {
      async capture(_url, opts) {
        sourceAttempts += 1;
        if (sourceAttempts === 1) throw new Error("transient network blip");
        return shot(1, opts?.sampleStyles ? SAMPLES : undefined);
      },
      async dispose() {},
    };
    const result = await captureImportGroundTruth({
      runId,
      adapter,
      registry,
      screenshotter: flaky,
      screenshotStorage: { async put() {} },
    });
    expect(sourceAttempts).toBe(2);
    expect(result.captured).toBe(1);
    const rep = await report(runId);
    expect(rep.pagesMissingScreenshot).toBe(0);
    expect(rep.notes.find((n) => n.category === "screenshot_missing")).toBeUndefined();
  });

  it("a persistently failing capture records a screenshot_missing note and leaves the page UNVERIFIED", async () => {
    const runId = await makeRun("https://issue247-dead.example/", [
      "https://issue247-dead.example/",
    ]);
    const dead: Screenshotter = {
      async capture() {
        throw new Error("net::ERR_NAME_NOT_RESOLVED");
      },
      async dispose() {},
    };
    const result = await captureImportGroundTruth({
      runId,
      adapter,
      registry,
      screenshotter: dead,
      screenshotStorage: { async put() {} },
    });
    expect(result.captured).toBe(0);
    expect(result.failed).toBe(1);
    const got = await execute(registry, adapter, SYSTEM, "imports.get", { runId });
    if (!got.ok) throw new Error(JSON.stringify(got.error));
    const page = (got.value as { pages: { screenshotObjectKey: string | null }[] }).pages[0];
    // No screenshot — UNVERIFIED, not silently "done".
    expect(page?.screenshotObjectKey).toBeNull();
    const rep = await report(runId);
    expect(rep.pagesMissingScreenshot).toBe(1);
    expect(rep.notes.find((n) => n.category === "screenshot_missing")?.suggested).toBe(1);
  });

  it("an unavailable screenshotter notes EVERY page instead of silently skipping (F9)", async () => {
    const runId = await makeRun("https://issue247-nopw.example/", [
      "https://issue247-nopw.example/",
      "https://issue247-nopw.example/about",
    ]);
    const result = await captureImportGroundTruth({
      runId,
      adapter,
      registry,
      screenshotter: null,
      screenshotStorage: { async put() {} },
    });
    expect(result.captured).toBe(0);
    expect(result.failed).toBe(2);
    const rep = await report(runId);
    expect(rep.pagesMissingScreenshot).toBe(2);
    expect(rep.notes.find((n) => n.category === "screenshot_missing")?.suggested).toBe(2);
  });

  it("a failing storage sink degrades to NULL keys plus a loud note, never a failed diff", async () => {
    const runId = await makeRun("https://issue247-dark.example/", [
      "https://issue247-dark.example/",
    ]);
    const result = await captureImportGroundTruth({
      runId,
      adapter,
      registry,
      screenshotter: fakeScreenshotter(),
      screenshotStorage: {
        async put() {
          throw new Error("bucket offline");
        },
      },
    });
    expect(result.captured).toBe(1);
    const got = await execute(registry, adapter, SYSTEM, "imports.get", { runId });
    if (!got.ok) throw new Error(JSON.stringify(got.error));
    const page = (
      got.value as {
        pages: {
          screenshotObjectKey: string | null;
          sampledDesignTokens: unknown;
        }[];
      }
    ).pages[0];
    expect(page?.screenshotObjectKey).toBeNull();
    // Tokens still landed — they don't depend on the object store.
    expect(page?.sampledDesignTokens).not.toBeNull();
    // issue #247 — the dropped pixels are LOUD, not a silent NULL key.
    const rep = await report(runId);
    expect(rep.pagesMissingScreenshot).toBe(1);
    expect(rep.notes.find((n) => n.category === "screenshot_missing")?.suggested).toBe(1);
  });
});

/** Minimal CrawledPage for the crawl-time persistence path (#423). */
function crawled(url: string, slug: string, styleSamples?: ElementStyleSample[]): CrawledPage {
  return {
    url,
    proposedSlug: slug,
    title: slug,
    modules: [],
    commentsStripped: 0,
    themeTokens: {},
    signature: slug,
    pageCss: "",
    ...(styleSamples ? { styleSamples } : {}),
  };
}

async function pagesOf(runId: string): Promise<
  Array<{
    id: string;
    sourceUrl: string;
    screenshotObjectKey: string | null;
    sampledDesignTokens: unknown;
  }>
> {
  const got = await execute(registry, adapter, SYSTEM, "imports.get", { runId });
  if (!got.ok) throw new Error(JSON.stringify(got.error));
  return (
    got.value as {
      pages: Array<{
        id: string;
        sourceUrl: string;
        screenshotObjectKey: string | null;
        sampledDesignTokens: unknown;
      }>;
    }
  ).pages;
}

describe("crawl-time capture persistence + scoped ground-truth pass (#423)", () => {
  it("persistBatchCapture lands keys + tokens in one bulk write and notes sampleless pages", async () => {
    const home = "https://issue423-batch.example/";
    const about = "https://issue423-batch.example/about";
    const runId = await makeRun(home, [home, about]);
    const keys = new Map([
      [home, `import-screenshots/${runId}/src-aaaa.png`],
      [about, `import-screenshots/${runId}/src-bbbb.png`],
    ]);
    await persistBatchCapture({
      runId,
      adapter,
      registry,
      // `about` rendered but returned zero samples — must be noted loudly,
      // because the scoped after-pass skips keyed pages and would never
      // see it.
      pages: [crawled(home, "home", SAMPLES), crawled(about, "about", [])],
      screenshotKeyByUrl: keys,
    });

    const pages = await pagesOf(runId);
    const homePage = pages.find((p) => p.sourceUrl === home);
    const aboutPage = pages.find((p) => p.sourceUrl === about);
    expect(homePage?.screenshotObjectKey).toBe(keys.get(home) ?? "");
    expect(homePage?.sampledDesignTokens).not.toBeNull();
    expect(aboutPage?.screenshotObjectKey).toBe(keys.get(about) ?? "");
    expect(aboutPage?.sampledDesignTokens).toBeNull();

    const rep = await report(runId);
    expect(rep.captureStats).toEqual({ captured: 2, failed: 0, skipped: 0 });
    expect(rep.pagesMissingScreenshot).toBe(0);
    expect(rep.notes.find((n) => n.category === "design_tokens_missing")?.suggested).toBe(1);

    // The run-level aggregate comes from row state — one page had tokens.
    expect(rep.siteDesignTokens).toBeNull();
    await writeRunDesignTokenAggregate({ runId, adapter, registry });
    const after = await report(runId);
    expect((after.siteDesignTokens as { pageCount: number }).pageCount).toBe(1);
  });

  it("persistBatchCapture fails LOUDLY when a capture matches no import_pages row", async () => {
    const home = "https://issue423-unmatched.example/";
    const runId = await makeRun(home, [home]);
    await expect(
      persistBatchCapture({
        runId,
        adapter,
        registry,
        pages: [crawled("https://issue423-unmatched.example/ghost", "ghost", SAMPLES)],
        screenshotKeyByUrl: new Map([
          ["https://issue423-unmatched.example/ghost", "import-screenshots/x/src-dead.png"],
        ]),
      }),
    ).rejects.toThrow("matched no import_pages row");
  });

  it("onlyPagesMissingScreenshot: skips crawl-captured pages, retries keyless ones, caller owns the aggregate", async () => {
    const home = "https://issue423-scoped.example/";
    const about = "https://issue423-scoped.example/about";
    const runId = await makeRun(home, [home, about]);
    // Crawl-time capture succeeded for the home page only.
    await persistBatchCapture({
      runId,
      adapter,
      registry,
      pages: [crawled(home, "home", SAMPLES)],
      screenshotKeyByUrl: new Map([[home, `import-screenshots/${runId}/src-home.png`]]),
    });

    const captureCalls: string[] = [];
    const counting: Screenshotter = {
      async capture(url, opts) {
        captureCalls.push(url);
        return shot(2, opts?.sampleStyles ? SAMPLES : undefined);
      },
      async dispose() {},
    };
    const result = await captureImportGroundTruth({
      runId,
      adapter,
      registry,
      screenshotter: counting,
      onlyPagesMissingScreenshot: true,
      screenshotStorage: { async put() {} },
    });
    // Only the keyless page was re-rendered.
    expect(captureCalls).toEqual([about]);
    expect(result.captured).toBe(1);
    expect(result.failed).toBe(0);

    const pages = await pagesOf(runId);
    const aboutPage = pages.find((p) => p.sourceUrl === about);
    expect(aboutPage?.screenshotObjectKey).toBe(
      `import-screenshots/${runId}/${aboutPage?.id}-source.png`,
    );

    // The scoped pass must NOT write the aggregate (it saw only a subset);
    // the caller aggregates from row state over BOTH pages.
    let rep = await report(runId);
    expect(rep.siteDesignTokens).toBeNull();
    await writeRunDesignTokenAggregate({ runId, adapter, registry });
    rep = await report(runId);
    expect((rep.siteDesignTokens as { pageCount: number }).pageCount).toBe(2);
    expect(rep.captureStats).toEqual({ captured: 2, failed: 0, skipped: 0 });
  });

  it("onlyPagesMissingScreenshot with nothing missing performs zero captures", async () => {
    const home = "https://issue423-done.example/";
    const runId = await makeRun(home, [home]);
    await persistBatchCapture({
      runId,
      adapter,
      registry,
      pages: [crawled(home, "home", SAMPLES)],
      screenshotKeyByUrl: new Map([[home, `import-screenshots/${runId}/src-home.png`]]),
    });
    let calls = 0;
    const tracking: Screenshotter = {
      async capture() {
        calls += 1;
        throw new Error("should not be called");
      },
      async dispose() {},
    };
    const result = await captureImportGroundTruth({
      runId,
      adapter,
      registry,
      screenshotter: tracking,
      onlyPagesMissingScreenshot: true,
      screenshotStorage: { async put() {} },
    });
    expect(calls).toBe(0);
    expect(result).toEqual({ captured: 0, failed: 0 });
  });

  it("captureStats: keyless+unnoted counts as skipped (silent degradation signal), noted as failed", async () => {
    const home = "https://issue423-stats.example/";
    const about = "https://issue423-stats.example/about";
    const runId = await makeRun(home, [home, about]);
    // Nothing captured, nothing noted yet → all skipped (the loud signal).
    let rep = await report(runId);
    expect(rep.captureStats).toEqual({ captured: 0, failed: 0, skipped: 2 });

    // The ground-truth pass fails persistently → loud notes → failed.
    const dead: Screenshotter = {
      async capture() {
        throw new Error("net::ERR_NAME_NOT_RESOLVED");
      },
      async dispose() {},
    };
    await captureImportGroundTruth({
      runId,
      adapter,
      registry,
      screenshotter: dead,
      onlyPagesMissingScreenshot: true,
      screenshotStorage: { async put() {} },
    });
    rep = await report(runId);
    expect(rep.captureStats).toEqual({ captured: 0, failed: 2, skipped: 0 });
  });
});
