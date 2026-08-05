// SPDX-License-Identifier: MPL-2.0

/**
 * Integration test for `imports.import_media_urls` — the explicit,
 * URL-driven media import that replaced the scan-and-download
 * `imports.migrate_media`.
 *
 * The AI names exact source-asset URLs; each is fetched through the
 * site-importer SSRF guard, re-encoded through the media pipeline, and
 * stored — deduped by content sha256. Everything unimportable comes back
 * in `skipped` with a reason (CLAUDE.md §2 — nothing silently dropped).
 *
 * The "source site" is a local Bun server; the SSRF guard admits it via
 * CAELO_IMPORTER_ALLOWED_HOSTS — the same exemption the e2e fixture
 * servers use. No real external network.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import type { ToolContext } from "../ai/tools/dispatch.js";
import { importMediaFromUrlsTool } from "../ai/tools/import-media-from-urls.js";
import { LocalVolumeAdapter, setMediaStorage } from "../media/storage.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let sqlc: SQL;
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let mediaRoot: string;
let savedAllowedHosts: string | undefined;

const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "import-urls-ai",
};
const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "import-urls-sys",
};

// 1x1 transparent PNG — small enough to inline, real enough for sharp.
const PNG_BYTES = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

// Minimal fake mp4: a 4-byte box size then the ISO-BMFF "ftyp" box type
// at offset 4 (0x66,0x74,0x79,0x70), then a brand. The pipeline stores
// mp4 as-is (no sharp validation), so this is enough to travel the whole
// import path and land as orig.mp4.
const MP4_BYTES = new Uint8Array([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 0x00, 0x00, 0x00, 0x00,
  0x6d, 0x70, 0x34, 0x32, 0x69, 0x73, 0x6f, 0x6d,
]);

async function cleanup(): Promise<void> {
  await sqlc.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    await tx`DELETE FROM media_variants WHERE asset_id IN (
      SELECT id FROM media_assets WHERE original_name LIKE 'importurls-%'
    )`;
    await tx`DELETE FROM media_alt_proposals WHERE asset_id IN (
      SELECT id FROM media_assets WHERE original_name LIKE 'importurls-%'
    )`;
    await tx`DELETE FROM media_assets WHERE original_name LIKE 'importurls-%'`;
    await tx`DELETE FROM import_pages WHERE source_url LIKE '%listassets%'`;
    await tx`DELETE FROM import_runs WHERE source_url LIKE '%listassets%'`;
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  sqlc = new SQL(ADMIN_URL!);

  mediaRoot = await mkdtemp(join(tmpdir(), "importurls-media-"));
  setMediaStorage(new LocalVolumeAdapter(mediaRoot), "local");

  savedAllowedHosts = process.env.CAELO_IMPORTER_ALLOWED_HOSTS;
  process.env.CAELO_IMPORTER_ALLOWED_HOSTS = "127.0.0.1";

  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/importurls-logo.png" || path === "/importurls-dup.png") {
        return new Response(PNG_BYTES, { headers: { "Content-Type": "image/png" } });
      }
      if (path === "/importurls-clip.mp4") {
        return new Response(MP4_BYTES, { headers: { "Content-Type": "video/mp4" } });
      }
      if (path === "/importurls-tracker.html") {
        return new Response("<!doctype html><html></html>", {
          headers: { "Content-Type": "text/html" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;

  await cleanup();
});

afterAll(async () => {
  await cleanup();
  server.stop(true);
  if (savedAllowedHosts === undefined) delete process.env.CAELO_IMPORTER_ALLOWED_HOSTS;
  else process.env.CAELO_IMPORTER_ALLOWED_HOSTS = savedAllowedHosts;
  await rm(mediaRoot, { recursive: true, force: true });
  await sqlc.end();
  await adapter.close();
});

interface ImportResult {
  imported: Array<{ sourceUrl: string; mediaId: string; slug: string; mediaUrl: string }>;
  skipped: Array<{ url: string; reason: string }>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("imports.import_media_urls", () => {
  it("imports a real image and returns its Caelo media URL", async () => {
    const r = await execute(registry, adapter, AI, "imports.import_media_urls", {
      assets: [{ url: `${baseUrl}/importurls-logo.png`, name: "importurls logo" }],
    });
    expect(r.ok).toBe(true);
    const v = (r as { value: ImportResult }).value;
    expect(v.skipped).toEqual([]);
    expect(v.imported).toHaveLength(1);
    const [entry] = v.imported;
    expect(entry?.sourceUrl).toBe(`${baseUrl}/importurls-logo.png`);
    expect(entry?.mediaId).toMatch(UUID_RE);
    // The slug is the meaningful public segment; the id stays internal.
    expect(entry?.slug).toBeTruthy();
    // The mediaUrl (flat slug form) is the path the AI drops into <img src>.
    expect(entry?.mediaUrl).toBe(`/_caelo/media/${entry?.slug}`);
  });

  it("imports an mp4 video and stores it as orig.mp4", async () => {
    const r = await execute(registry, adapter, AI, "imports.import_media_urls", {
      assets: [{ url: `${baseUrl}/importurls-clip.mp4`, name: "importurls clip" }],
    });
    expect(r.ok).toBe(true);
    const v = (r as { value: ImportResult }).value;
    expect(v.skipped).toEqual([]);
    expect(v.imported).toHaveLength(1);
    const [entry] = v.imported;
    expect(entry?.sourceUrl).toBe(`${baseUrl}/importurls-clip.mp4`);
    expect(entry?.mediaId).toMatch(UUID_RE);
    expect(entry?.mediaUrl).toBe(`/_caelo/media/${entry?.slug}`);

    // The asset lands under video/mp4 with an orig.mp4 storage key.
    // RLS is FORCEd, so the raw read must run as a system actor (mirrors the
    // wipe helper) — otherwise the row is invisible and mime reads undefined.
    let rows: Array<{ mime: string; storage_key: string }> = [];
    await sqlc.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      rows = (await tx`
        SELECT a.mime AS mime, vnt.storage_key AS storage_key
        FROM media_assets a
        JOIN media_variants vnt ON vnt.asset_id = a.id
        WHERE a.id = ${entry?.mediaId}::uuid AND vnt.variant = 'orig'
        LIMIT 1`) as unknown as Array<{ mime: string; storage_key: string }>;
    });
    expect(rows[0]?.mime).toBe("video/mp4");
    expect(String(rows[0]?.storage_key)).toMatch(/\/orig\.mp4$/);
  });

  it("dedupes identical bytes served under two URLs to the same media asset", async () => {
    const r = await execute(registry, adapter, AI, "imports.import_media_urls", {
      assets: [
        { url: `${baseUrl}/importurls-logo.png`, name: "dup logo a" },
        { url: `${baseUrl}/importurls-dup.png`, name: "dup logo b" },
      ],
    });
    expect(r.ok).toBe(true);
    const v = (r as { value: ImportResult }).value;
    expect(v.skipped).toEqual([]);
    expect(v.imported).toHaveLength(2);
    // Same content hash → both resolve to one media asset id.
    expect(v.imported[0]?.mediaId).toBe(v.imported[1]?.mediaId);
  });

  it("skips non-image content types, HTTP errors, and SSRF-blocked hosts — each with a reason", async () => {
    const r = await execute(registry, adapter, AI, "imports.import_media_urls", {
      assets: [
        { url: `${baseUrl}/importurls-logo.png` }, // ok → imported
        { url: `${baseUrl}/importurls-tracker.html` }, // text/html → blocked-content-type
        { url: `${baseUrl}/importurls-missing.png` }, // 404 → http-404
        { url: "http://10.0.0.1/private.png" }, // private host, not allowlisted → SSRF
      ],
    });
    expect(r.ok).toBe(true);
    const v = (r as { value: ImportResult }).value;

    expect(v.imported.map((i) => i.sourceUrl)).toEqual([`${baseUrl}/importurls-logo.png`]);

    const reasonFor = (url: string) => v.skipped.find((s) => s.url === url)?.reason ?? "";
    expect(reasonFor(`${baseUrl}/importurls-tracker.html`)).toContain("blocked-content-type");
    expect(reasonFor(`${baseUrl}/importurls-missing.png`)).toContain("http-404");
    expect(reasonFor("http://10.0.0.1/private.png")).toContain("blocked-by-ssrf-guard");
    expect(v.skipped).toHaveLength(3);
  });

  it("rejects an empty asset list at the validator (min 1)", async () => {
    const r = await execute(registry, adapter, AI, "imports.import_media_urls", { assets: [] });
    expect(r.ok).toBe(false);
  });
});

describe("import_media_from_urls tool output", () => {
  it("result lines carry each row's mediaId so the model can bind it (issue #411)", async () => {
    // The op always returned mediaId; the TOOL printed only sourceUrl →
    // mediaUrl, so the model-visible content had no bindable id. Assert
    // on the content string — it is all the model ever sees.
    const r = await importMediaFromUrlsTool.handler(
      AI,
      { assets: [{ url: `${baseUrl}/importurls-logo.png`, name: "importurls tool logo" }] },
      { adapter, registry } as ToolContext,
    );
    expect(r.ok).toBe(true);
    const line = r.content.split("\n").find((l) => l.includes("/importurls-logo.png"));
    expect(line).toBeDefined();
    const id = line?.match(/mediaId ([0-9a-f-]{36})/)?.[1] ?? "";
    expect(id).toMatch(UUID_RE);
  });
});

interface AssetList {
  total: number;
  pagesScanned: number;
  assets: Array<{ url: string; count: number; pages: number; alt: string | null }>;
}

/** Seed a run with two crawled pages whose stored HTML hotlinks every asset
 *  type discoverAssetRefs handles: img src+srcset, CSS url(), video poster,
 *  and <source> src. Returns { runId, page2Url }. */
async function seedAssetRun(): Promise<{ runId: string; page2Url: string }> {
  const run = await execute(registry, adapter, SYSTEM, "imports.create_run", {
    sourceUrl: `${baseUrl}/?listassets`,
    depth: 1,
    maxPages: 10,
  });
  if (!run.ok) throw new Error(JSON.stringify(run.error));
  const runId = (run.value as { runId: string }).runId;
  const page1Url = `${baseUrl}/listassets-home`;
  const page2Url = `${baseUrl}/listassets-about`;
  const wrote = await execute(registry, adapter, SYSTEM, "imports.write_extracted_pages", {
    runId,
    pages: [
      {
        sourceUrl: page1Url,
        proposedSlug: "listassets-home",
        proposedTitle: "Home",
        proposedModules: [
          {
            blockName: "content",
            position: 0,
            html:
              `<img src="/logo.png" srcset="/logo-2x.png 2x" alt="Logo">` +
              `<div style="background-image:url('/hero-bg.jpg')"></div>` +
              `<video poster="/poster.jpg"><source src="/clip.mp4"></video>`,
            displayName: "Content",
          },
        ],
        proposedThemeTokens: {},
        signature: "home",
      },
      {
        sourceUrl: page2Url,
        proposedSlug: "listassets-about",
        proposedTitle: "About",
        // Repeats /logo.png so it ranks first (appears on both pages).
        proposedModules: [
          { blockName: "content", position: 0, html: `<img src="/logo.png">`, displayName: "C" },
        ],
        proposedThemeTokens: {},
        signature: "about",
      },
    ],
  });
  if (!wrote.ok) throw new Error(JSON.stringify(wrote.error));
  return { runId, page2Url };
}

describe("imports.list_page_assets", () => {
  it("discovers ALL asset types across a run's stored HTML, ranked by prominence", async () => {
    const { runId } = await seedAssetRun();
    const r = await execute(registry, adapter, AI, "imports.list_page_assets", { runId });
    expect(r.ok).toBe(true);
    const v = (r as { value: AssetList }).value;
    expect(v.pagesScanned).toBe(2);

    const urls = v.assets.map((a) => a.url);
    // img src, srcset, CSS url(), video poster, <source> src — all found.
    expect(urls).toContain(`${baseUrl}/logo.png`);
    expect(urls).toContain(`${baseUrl}/logo-2x.png`);
    expect(urls).toContain(`${baseUrl}/hero-bg.jpg`);
    expect(urls).toContain(`${baseUrl}/poster.jpg`);
    expect(urls).toContain(`${baseUrl}/clip.mp4`);
    expect(v.total).toBe(5);

    // /logo.png appears on both pages → ranked first, count 2, pages 2.
    expect(v.assets[0]?.url).toBe(`${baseUrl}/logo.png`);
    expect(v.assets[0]?.count).toBe(2);
    expect(v.assets[0]?.pages).toBe(2);
  });

  it("filters by substring search", async () => {
    const { runId } = await seedAssetRun();
    const r = await execute(registry, adapter, AI, "imports.list_page_assets", {
      runId,
      search: "bg",
    });
    expect(r.ok).toBe(true);
    const v = (r as { value: AssetList }).value;
    expect(v.assets.map((a) => a.url)).toEqual([`${baseUrl}/hero-bg.jpg`]);
  });

  it("narrows to a single crawled page via pageUrl", async () => {
    const { runId, page2Url } = await seedAssetRun();
    const r = await execute(registry, adapter, AI, "imports.list_page_assets", {
      runId,
      pageUrl: page2Url,
    });
    expect(r.ok).toBe(true);
    const v = (r as { value: AssetList }).value;
    expect(v.pagesScanned).toBe(1);
    expect(v.assets.map((a) => a.url)).toEqual([`${baseUrl}/logo.png`]);
  });

  it("errors loudly for an unknown run id", async () => {
    const r = await execute(registry, adapter, AI, "imports.list_page_assets", {
      runId: "00000000-0000-0000-0000-0000000000ff",
    });
    expect(r.ok).toBe(false);
  });
});
