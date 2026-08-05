// SPDX-License-Identifier: MPL-2.0

/**
 * issue #423 — op-tier coverage for crawl-time capture persistence, in the
 * stage-harness style (real ops, real Postgres, no browser):
 *
 *   create_run → write_extracted_pages → set_page_captures_by_url
 *     → get / get_page_screenshot_keys / get_run_report
 *
 * Verifies the bulk write's semantics (URL-keyed update, COALESCE
 * keep-on-omit, loud `unmatched`), that the #198 read surfaces see the
 * crawl-time captures, and that the run report's captureStats ledger
 * classifies captured / failed / skipped correctly (CLAUDE.md §2 — a
 * `skipped` page is the silent-degradation signal).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "issue423-capture-persistence",
};

beforeAll(() => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

afterAll(async () => {
  await adapter.close();
});

const TOKENS = {
  palette: [{ value: "#111111", count: 4 }],
  backgrounds: [{ value: "#ffffff", count: 2 }],
  fontFamilies: [{ value: "Inter, sans-serif", count: 3 }],
  fontSizes: [{ value: "16px", count: 3 }],
  fontWeights: [{ value: "400", count: 3 }],
  radii: [],
  shadows: [],
  spacing: {},
  roles: { body: { color: "#111111", backgroundColor: "#ffffff" } },
};

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

async function pageRows(runId: string): Promise<
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

describe("imports.set_page_captures_by_url (#423)", () => {
  it("updates by (runId, sourceUrl), returns resolved ids, and the read surfaces see it", async () => {
    const home = "https://svfx423-a.example/";
    const about = "https://svfx423-a.example/about";
    const runId = await makeRun(home, [home, about]);
    const key = `import-screenshots/${runId}/src-cafe.png`;

    const r = await execute(registry, adapter, SYSTEM, "imports.set_page_captures_by_url", {
      runId,
      captures: [
        { sourceUrl: home, screenshotObjectKey: key, sampledDesignTokens: TOKENS },
        { sourceUrl: about, sampledDesignTokens: TOKENS },
      ],
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const v = r.value as {
      updated: Array<{ importPageId: string; sourceUrl: string }>;
      unmatched: string[];
    };
    expect(v.unmatched).toEqual([]);
    expect(v.updated.map((u) => u.sourceUrl).sort()).toEqual([home, about].sort());

    const pages = await pageRows(runId);
    const homeRow = pages.find((p) => p.sourceUrl === home);
    expect(homeRow?.screenshotObjectKey).toBe(key);
    expect(homeRow?.sampledDesignTokens).not.toBeNull();
    // Tokens-only capture: key stays NULL, tokens land.
    const aboutRow = pages.find((p) => p.sourceUrl === about);
    expect(aboutRow?.screenshotObjectKey).toBeNull();
    expect(aboutRow?.sampledDesignTokens).not.toBeNull();

    // #198 read surface (screenshot serve route / look-at-original tool).
    const keys = await execute(registry, adapter, SYSTEM, "imports.get_page_screenshot_keys", {
      importPageId: homeRow?.id ?? "",
    });
    if (!keys.ok) throw new Error(JSON.stringify(keys.error));
    expect((keys.value as { screenshotObjectKey: string | null }).screenshotObjectKey).toBe(key);
  });

  it("COALESCE semantics: an omitted field never clears a stored value", async () => {
    const home = "https://svfx423-b.example/";
    const runId = await makeRun(home, [home]);
    const key = `import-screenshots/${runId}/src-beef.png`;

    const first = await execute(registry, adapter, SYSTEM, "imports.set_page_captures_by_url", {
      runId,
      captures: [{ sourceUrl: home, screenshotObjectKey: key }],
    });
    if (!first.ok) throw new Error(JSON.stringify(first.error));
    // Second write carries only tokens (e.g. a checkpoint replay) — the
    // stored key must survive.
    const second = await execute(registry, adapter, SYSTEM, "imports.set_page_captures_by_url", {
      runId,
      captures: [{ sourceUrl: home, sampledDesignTokens: TOKENS }],
    });
    if (!second.ok) throw new Error(JSON.stringify(second.error));

    const row = (await pageRows(runId))[0];
    expect(row?.screenshotObjectKey).toBe(key);
    expect(row?.sampledDesignTokens).not.toBeNull();
  });

  it("rejects a capture carrying neither a key nor tokens (silent-no-op guard)", async () => {
    const home = "https://svfx423-e.example/";
    const runId = await makeRun(home, [home]);
    const r = await execute(registry, adapter, SYSTEM, "imports.set_page_captures_by_url", {
      runId,
      captures: [{ sourceUrl: home }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(JSON.stringify(r.error)).toContain("silent no-op");
  });

  it("reports unknown sourceUrls in `unmatched` instead of silently dropping them", async () => {
    const home = "https://svfx423-c.example/";
    const runId = await makeRun(home, [home]);
    const r = await execute(registry, adapter, SYSTEM, "imports.set_page_captures_by_url", {
      runId,
      captures: [
        { sourceUrl: home, sampledDesignTokens: TOKENS },
        { sourceUrl: "https://svfx423-c.example/ghost", sampledDesignTokens: TOKENS },
      ],
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const v = r.value as { updated: unknown[]; unmatched: string[] };
    expect(v.updated.length).toBe(1);
    expect(v.unmatched).toEqual(["https://svfx423-c.example/ghost"]);
  });

  it("run report captureStats: captured / failed (noted) / skipped (silent)", async () => {
    const home = "https://svfx423-d.example/";
    const noted = "https://svfx423-d.example/noted";
    const silent = "https://svfx423-d.example/silent";
    const runId = await makeRun(home, [home, noted, silent]);

    await execute(registry, adapter, SYSTEM, "imports.set_page_captures_by_url", {
      runId,
      captures: [
        {
          sourceUrl: home,
          screenshotObjectKey: `import-screenshots/${runId}/src-1.png`,
          sampledDesignTokens: TOKENS,
        },
      ],
    });
    // `noted` failed capture and carries the ratified loud marker.
    const notedId = (await pageRows(runId)).find((p) => p.sourceUrl === noted)?.id ?? "";
    const note = await execute(registry, adapter, SYSTEM, "imports.add_page_notes", {
      importPageId: notedId,
      notes: [
        {
          category: "screenshot_missing",
          note: "Source screenshot NOT captured after a retry (test). This page is UNVERIFIED.",
          applied: false,
        },
      ],
    });
    if (!note.ok) throw new Error(JSON.stringify(note.error));

    const rep = await execute(registry, adapter, SYSTEM, "imports.get_run_report", { runId });
    if (!rep.ok) throw new Error(JSON.stringify(rep.error));
    const stats = (
      rep.value as { captureStats: { captured: number; failed: number; skipped: number } }
    ).captureStats;
    expect(stats).toEqual({ captured: 1, failed: 1, skipped: 1 });
  });
});
