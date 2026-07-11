// SPDX-License-Identifier: MPL-2.0

/**
 * issue #198 — captureImportDiffs persists BOTH captures (source +
 * staged) to the injected storage and lands their keys on the
 * import_pages row alongside the diff verdict. Real Postgres ops
 * (admin-core is a devDependency for exactly this); screenshotter and
 * storage are injected fakes — Chromium has no place in a unit lane.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { registerAdminOps } from "@caelo-cms/admin-core";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import type { Screenshot, Screenshotter } from "@caelo-cms/site-importer";
import { captureImportDiffs } from "./index.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "issue198-capture",
};

beforeAll(() => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

afterAll(async () => {
  await adapter.close();
});

const shot = (fill: number): Screenshot => ({
  bytes: new Uint8Array(64).fill(fill),
  width: 8,
  height: 2,
});

function fakeScreenshotter(): Screenshotter {
  return {
    async capture(url) {
      // Distinguishable bytes per side so the storage assertion is real.
      return url.startsWith("http://localhost") ? shot(2) : shot(1);
    },
    async dispose() {},
  };
}

describe("captureImportDiffs persistence (#198)", () => {
  it("uploads source + staged captures and stores their keys on the page row", async () => {
    const run = await execute(registry, adapter, SYSTEM, "imports.create_run", {
      sourceUrl: "https://issue198.example/",
      depth: 1,
      maxPages: 5,
    });
    if (!run.ok) throw new Error(JSON.stringify(run.error));
    const runId = (run.value as { runId: string }).runId;
    const wrote = await execute(registry, adapter, SYSTEM, "imports.write_extracted_pages", {
      runId,
      pages: [
        {
          sourceUrl: "https://issue198.example/",
          proposedSlug: "home",
          proposedTitle: "Home",
          proposedModules: [],
          proposedThemeTokens: {},
          signature: "home",
        },
      ],
    });
    if (!wrote.ok) throw new Error(JSON.stringify(wrote.error));

    const stored = new Map<string, Uint8Array>();
    const result = await captureImportDiffs({
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

    const got = await execute(registry, adapter, SYSTEM, "imports.get", { runId });
    if (!got.ok) throw new Error(JSON.stringify(got.error));
    const page = (
      got.value as {
        pages: {
          id: string;
          screenshotObjectKey: string | null;
          stagedScreenshotObjectKey: string | null;
          diffStatus: string | null;
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
  });

  it("a failing storage sink degrades to NULL keys, never a failed diff", async () => {
    const run = await execute(registry, adapter, SYSTEM, "imports.create_run", {
      sourceUrl: "https://issue198-dark.example/",
      depth: 1,
      maxPages: 5,
    });
    if (!run.ok) throw new Error(JSON.stringify(run.error));
    const runId = (run.value as { runId: string }).runId;
    await execute(registry, adapter, SYSTEM, "imports.write_extracted_pages", {
      runId,
      pages: [
        {
          sourceUrl: "https://issue198-dark.example/",
          proposedSlug: "home",
          proposedTitle: "Home",
          proposedModules: [],
          proposedThemeTokens: {},
        },
      ],
    });
    const result = await captureImportDiffs({
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
    const page = (
      got.value as {
        pages: { screenshotObjectKey: string | null; diffStatus: string | null }[];
      }
    ).pages[0];
    expect(page?.screenshotObjectKey).toBeNull();
    expect(page?.diffStatus).not.toBeNull();
  });
});
