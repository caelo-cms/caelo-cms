// SPDX-License-Identifier: MPL-2.0

/**
 * issue #249 (WS3) — media migration over a composed import run:
 * downloads land in the media library (sha-deduped, alt carried over),
 * module HTML + template CSS are rewritten to Caelo media URLs, the
 * unmigratable are reported loudly, and a re-run is idempotent.
 *
 * The "source site" is a local Bun server; the SSRF guard admits it
 * via CAELO_IMPORTER_ALLOWED_HOSTS — the same exemption the e2e
 * fixture servers use. No real network.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
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

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "issue249-media-sys",
};
const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "issue249-media-ai",
};

// 1x1 transparent PNG — small enough to inline, real enough for sharp.
const PNG_BYTES = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);
const WOFF2_BYTES = new TextEncoder().encode("wOF2-fake-font-payload-issue249");

async function cleanup(): Promise<void> {
  await sqlc.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE 'issue249-%')`;
    await tx`DELETE FROM pages WHERE slug LIKE 'issue249-%'`;
    await tx`DELETE FROM content_instances WHERE module_id IN (
      SELECT id FROM modules WHERE slug LIKE 'imported-%'
    ) AND id NOT IN (SELECT content_instance_id FROM page_modules)`;
    await tx`DELETE FROM modules WHERE slug LIKE 'imported-%'
      AND id NOT IN (SELECT module_id FROM page_modules)`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE 'issue249-tpl%')`;
    await tx`DELETE FROM templates WHERE slug LIKE 'issue249-tpl%'`;
    await tx`DELETE FROM import_pages WHERE source_url LIKE 'http://127.0.0.1%issue249%'`;
    await tx`DELETE FROM import_runs WHERE source_url LIKE 'http://127.0.0.1%issue249%'`;
    await tx`DELETE FROM media_variants WHERE asset_id IN (
      SELECT id FROM media_assets WHERE original_name LIKE 'issue249-%'
    )`;
    await tx`DELETE FROM media_alt_proposals WHERE asset_id IN (
      SELECT id FROM media_assets WHERE original_name LIKE 'issue249-%'
    )`;
    await tx`DELETE FROM media_assets WHERE original_name LIKE 'issue249-%'`;
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  sqlc = new SQL(ADMIN_URL!);

  mediaRoot = await mkdtemp(join(tmpdir(), "issue249-media-"));
  setMediaStorage(new LocalVolumeAdapter(mediaRoot), "local");

  savedAllowedHosts = process.env.CAELO_IMPORTER_ALLOWED_HOSTS;
  process.env.CAELO_IMPORTER_ALLOWED_HOSTS = "127.0.0.1";

  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/issue249-hero.png" || path === "/issue249-dup.png") {
        return new Response(PNG_BYTES, { headers: { "Content-Type": "image/png" } });
      }
      if (path === "/fonts/issue249-brand.woff2") {
        return new Response(WOFF2_BYTES, { headers: { "Content-Type": "font/woff2" } });
      }
      if (path === "/issue249-tracker.html") {
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

async function seedAndCompose(): Promise<string> {
  const run = await execute(registry, adapter, SYSTEM, "imports.create_run", {
    sourceUrl: `${baseUrl}/?issue249`,
    depth: 1,
    maxPages: 10,
  });
  if (!run.ok) throw new Error(JSON.stringify(run.error));
  const runId = (run.value as { runId: string }).runId;
  const wrote = await execute(registry, adapter, SYSTEM, "imports.write_extracted_pages", {
    runId,
    pages: [
      {
        sourceUrl: `${baseUrl}/issue249-home`,
        proposedSlug: "issue249-home",
        proposedTitle: "Issue 249 Home",
        proposedModules: [
          {
            blockName: "content",
            position: 0,
            html:
              `<section><img src="/issue249-hero.png" alt="Ein Held">` +
              // Same bytes under a second URL — must dedupe by sha256.
              `<img src="issue249-dup.png">` +
              // text/html content-type — must land in `skipped`, loudly.
              `<img src="${baseUrl}/issue249-tracker.html"></section>`,
            displayName: "Issue249 Content",
          },
        ],
        proposedThemeTokens: {},
        signature: "home",
        pageCss: '@font-face { font-family: Brand; src: url("/fonts/issue249-brand.woff2"); }',
      },
    ],
  });
  if (!wrote.ok) throw new Error(JSON.stringify(wrote.error));
  await execute(registry, adapter, SYSTEM, "imports.update_run_status", {
    runId,
    status: "ready_for_review",
    pagesSeen: 1,
    pagesExtracted: 1,
  });
  const composed = await execute(registry, adapter, SYSTEM, "imports.compose_from_run", {
    runId,
    templateSlug: "issue249-tpl",
  });
  if (!composed.ok) throw new Error(JSON.stringify(composed.error));
  return runId;
}

interface Report {
  migrated: number;
  migratedBytes: number;
  dedupedExisting: number;
  alreadyLocal: number;
  modulesRewritten: number;
  templatesRewritten: number;
  skipped: Array<{ url: string; reason: string }>;
}

describe("imports.migrate_media (#249)", () => {
  it("downloads, dedupes, rewrites, reports skips loudly, and re-runs idempotently", async () => {
    const runId = await seedAndCompose();

    const first = await execute(registry, adapter, AI, "imports.migrate_media", { runId });
    if (!first.ok) throw new Error(JSON.stringify(first.error));
    const report = first.value as Report;

    // hero.png downloaded; dup.png is the same bytes → sha-dedup;
    // the woff2 from template CSS downloaded.
    expect(report.migrated).toBe(2);
    expect(report.dedupedExisting).toBe(1);
    expect(report.migratedBytes).toBe(PNG_BYTES.byteLength + WOFF2_BYTES.byteLength);
    expect(report.modulesRewritten).toBe(1);
    expect(report.templatesRewritten).toBe(1);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]?.url).toContain("issue249-tracker.html");
    expect(report.skipped[0]?.reason).toContain("blocked-content-type");

    const { moduleHtml, templateCss, assets } = await sqlc.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const mods = (await tx`
        SELECT m.html FROM modules m
        JOIN page_modules pm ON pm.module_id = m.id
        JOIN pages p ON p.id = pm.page_id
        WHERE p.slug = 'issue249-home'
      `) as Array<{ html: string }>;
      const tpls = (await tx`
        SELECT css FROM templates WHERE slug LIKE 'issue249-tpl%'
      `) as Array<{ css: string }>;
      const media = (await tx`
        SELECT original_name, alt, usage_count FROM media_assets
        WHERE original_name LIKE 'issue249-%' AND deleted_at IS NULL
        ORDER BY original_name
      `) as Array<{ original_name: string; alt: string; usage_count: number }>;
      return { moduleHtml: mods[0]?.html ?? "", templateCss: tpls[0]?.css ?? "", assets: media };
    });

    // Both PNG references now point at the SAME asset (dedup), the
    // skipped tracker URL is untouched (reported, not hidden).
    const mediaRefs = moduleHtml.match(/\/_caelo\/media\/[0-9a-f-]{36}\/orig/g) ?? [];
    expect(mediaRefs).toHaveLength(2);
    expect(new Set(mediaRefs).size).toBe(1);
    expect(moduleHtml).toContain("issue249-tracker.html");
    expect(moduleHtml).not.toContain("issue249-hero.png");
    expect(templateCss).toContain("/_caelo/media/");
    expect(templateCss).not.toContain("issue249-brand.woff2");

    // Library rows: alt carried from the source markup; usage counted.
    expect(assets.map((a) => a.original_name)).toEqual([
      "issue249-brand.woff2",
      "issue249-hero.png",
    ]);
    const hero = assets.find((a) => a.original_name === "issue249-hero.png");
    expect(hero?.alt).toBe("Ein Held");
    expect(Number(hero?.usage_count)).toBe(1);

    // Re-run: nothing new to download, already-local refs counted,
    // the skipped tracker is re-reported (still unmigrated, still loud).
    const second = await execute(registry, adapter, AI, "imports.migrate_media", { runId });
    if (!second.ok) throw new Error(JSON.stringify(second.error));
    const rerun = second.value as Report;
    expect(rerun.migrated).toBe(0);
    expect(rerun.dedupedExisting).toBe(0);
    expect(rerun.alreadyLocal).toBe(3);
    expect(rerun.modulesRewritten).toBe(0);
    expect(rerun.templatesRewritten).toBe(0);
    expect(rerun.skipped).toHaveLength(1);
  });

  it("fails loudly when the run has no composed pages yet", async () => {
    const run = await execute(registry, adapter, SYSTEM, "imports.create_run", {
      sourceUrl: `${baseUrl}/?issue249-empty`,
      depth: 1,
      maxPages: 5,
    });
    if (!run.ok) throw new Error(JSON.stringify(run.error));
    const r = await execute(registry, adapter, AI, "imports.migrate_media", {
      runId: (run.value as { runId: string }).runId,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(JSON.stringify(r.error)).toContain("compose_from_import");
    }
  });
});
