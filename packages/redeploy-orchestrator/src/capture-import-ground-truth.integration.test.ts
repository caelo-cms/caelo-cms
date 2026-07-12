// SPDX-License-Identifier: MPL-2.0

/**
 * issue #247 (WS1) — captureImportGroundTruth is the always-on design
 * ground-truth pass: source screenshot + computed-style token sampling
 * in one render session, staged diff, and a LOUD `screenshot_missing` /
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
import type { ElementStyleSample, Screenshot, Screenshotter } from "@caelo-cms/site-importer";
import { captureImportGroundTruth } from "./index.js";

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

/** Source captures return samples when asked; staged captures don't. */
function fakeScreenshotter(): Screenshotter {
  return {
    async capture(url, opts) {
      // Distinguishable bytes per side so the storage assertion is real.
      if (url.startsWith("http://localhost")) return shot(2);
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
      stagedPreviewBaseUrl: "http://localhost:9999",
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
          stagedScreenshotObjectKey: string | null;
          diffStatus: string | null;
          sampledDesignTokens: {
            palette: { value: string; count: number }[];
            roles: Record<string, Record<string, string>>;
          } | null;
        }[];
      }
    ).pages[0];
    if (!page) throw new Error("page missing");
    expect(page.screenshotObjectKey).toBe(`import-screenshots/${runId}/${page.id}-source.png`);
    expect(page.stagedScreenshotObjectKey).toBe(
      `import-screenshots/${runId}/${page.id}-staged.png`,
    );
    expect(page.diffStatus).not.toBeNull();
    // Both objects actually landed, with the right bytes on each side.
    expect(stored.get(page.screenshotObjectKey ?? "")?.[0]).toBe(1);
    expect(stored.get(page.stagedScreenshotObjectKey ?? "")?.[0]).toBe(2);

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
      async capture(url, opts) {
        if (url.startsWith("http://localhost")) return shot(2);
        sourceAttempts += 1;
        if (sourceAttempts === 1) throw new Error("transient network blip");
        return shot(1, opts?.sampleStyles ? SAMPLES : undefined);
      },
      async dispose() {},
    };
    const result = await captureImportGroundTruth({
      runId,
      stagedPreviewBaseUrl: "http://localhost:9999",
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
      async capture(url) {
        if (url.startsWith("http://localhost")) return shot(2);
        throw new Error("net::ERR_NAME_NOT_RESOLVED");
      },
      async dispose() {},
    };
    const result = await captureImportGroundTruth({
      runId,
      stagedPreviewBaseUrl: "http://localhost:9999",
      adapter,
      registry,
      screenshotter: dead,
      screenshotStorage: { async put() {} },
    });
    expect(result.captured).toBe(0);
    expect(result.failed).toBe(1);
    const got = await execute(registry, adapter, SYSTEM, "imports.get", { runId });
    if (!got.ok) throw new Error(JSON.stringify(got.error));
    const page = (
      got.value as { pages: { screenshotObjectKey: string | null; diffStatus: string | null }[] }
    ).pages[0];
    // No screenshot, no diff verdict — UNVERIFIED, not silently "done".
    expect(page?.screenshotObjectKey).toBeNull();
    expect(page?.diffStatus).toBeNull();
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
      stagedPreviewBaseUrl: "http://localhost:9999",
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
      stagedPreviewBaseUrl: "http://localhost:9999",
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
          diffStatus: string | null;
          sampledDesignTokens: unknown;
        }[];
      }
    ).pages[0];
    expect(page?.screenshotObjectKey).toBeNull();
    expect(page?.diffStatus).not.toBeNull();
    // Tokens still landed — they don't depend on the object store.
    expect(page?.sampledDesignTokens).not.toBeNull();
    // issue #247 — the dropped pixels are LOUD, not a silent NULL key.
    const rep = await report(runId);
    expect(rep.pagesMissingScreenshot).toBe(1);
    expect(rep.notes.find((n) => n.category === "screenshot_missing")?.suggested).toBe(1);
  });
});
