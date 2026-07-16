// SPDX-License-Identifier: MPL-2.0

/**
 * P6 deploy round-trip: seed a published page → deploy.trigger → verify
 * dist/<env>/<slug>/index.html exists with the composed body, plus
 * robots.txt and routing-manifest.json.
 *
 * Also pins:
 *   - staging robots.txt blocks crawlers (`Disallow: /`).
 *   - AI actor can call deploy.trigger (trigger-only AI surface).
 *   - deploy_runs row records succeeded + counts.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { setDeployBridge } from "../ops/deploy.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let testRoot: string;

const HUMAN: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "p6-deploy-test",
};
const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "p6-deploy-test-ai",
};

const TPL_SLUG = "p6-deploy-tpl";
const MOD_SLUG = "p6-deploy-mod";
const PAGE_SLUG = "p6-about";
// issue #302 — staging/production builds fail loudly unless a published
// page maps to index.html, so the fixture ships a root page alongside
// the slug the assertions inspect.
const HOME_SLUG = "home";

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM deploy_runs`;
      await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug IN (${PAGE_SLUG}, ${HOME_SLUG}))`;
      await tx`DELETE FROM pages WHERE slug IN (${PAGE_SLUG}, ${HOME_SLUG})`;
      await tx`DELETE FROM modules WHERE slug = ${MOD_SLUG}`;
      await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${TPL_SLUG})`;
      await tx`DELETE FROM templates WHERE slug = ${TPL_SLUG}`;
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  // P6.2 — the trigger op spawns the static-generator CLI as a
  // subprocess and writes progress rows back via the bridge. Tests
  // configure it the same way the route layer does at startup.
  setDeployBridge({ registry, adapter });
  testRoot = await mkdtemp(join(tmpdir(), "caelo-p6-"));
});

afterAll(async () => {
  await wipe();
  await rm(testRoot, { recursive: true, force: true });
  await adapter.close();
});

async function seedPage(): Promise<string> {
  const t = await execute(registry, adapter, HUMAN, "templates.create", {
    slug: TPL_SLUG,
    displayName: "T",
    html: `<html><head><title>x</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
    css: "body{margin:0}",
  });
  if (!t.ok) throw new Error("template seed");
  const templateId = (t.value as { templateId: string }).templateId;

  const m = await execute(registry, adapter, HUMAN, "modules.create", {
    slug: MOD_SLUG,
    displayName: "M",
    html: "<p>hello world</p>",
    css: "p{color:red}",
    js: "",
    // v0.12.2 — opt out of extractor so the deployed HTML carries the
    // literal "hello world" the test asserts on.
    fields: [{ name: "body", kind: "text", label: "Body" } as never],
  });
  if (!m.ok) throw new Error("module seed");
  const moduleId = (m.value as { moduleId: string }).moduleId;

  const blocks = await execute(registry, adapter, HUMAN, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  if (!blocks.ok) throw new Error("blocks seed");

  const p = await execute(registry, adapter, HUMAN, "pages.create", {
    slug: PAGE_SLUG,
    title: "About",
    templateId,
    locale: "en",
  });
  if (!p.ok) throw new Error("page seed");
  const pageId = (p.value as { pageId: string }).pageId;

  const sm = await execute(registry, adapter, HUMAN, "pages.set_modules", {
    pageId,
    blocks: [{ blockName: "content", moduleIds: [moduleId] }],
  });
  if (!sm.ok) throw new Error("set_modules seed");

  const upd = await execute(registry, adapter, HUMAN, "pages.update", {
    pageId,
    status: "published",
  });
  if (!upd.ok) throw new Error("publish seed");

  // issue #302 — a published root page ('home' → index.html) so full
  // staging/production builds pass the missing-root-page guard.
  const hp = await execute(registry, adapter, HUMAN, "pages.create", {
    slug: HOME_SLUG,
    title: "Home",
    templateId,
    locale: "en",
  });
  if (!hp.ok) throw new Error("home page seed");
  const homePageId = (hp.value as { pageId: string }).pageId;
  const hm = await execute(registry, adapter, HUMAN, "pages.set_modules", {
    pageId: homePageId,
    blocks: [{ blockName: "content", moduleIds: [moduleId] }],
  });
  if (!hm.ok) throw new Error("home set_modules seed");
  const hupd = await execute(registry, adapter, HUMAN, "pages.update", {
    pageId: homePageId,
    status: "published",
  });
  if (!hupd.ok) throw new Error("home publish seed");
  return pageId;
}

describe("P6 deploy.trigger", () => {
  it("emits one HTML file per published page plus robots + manifest", async () => {
    await seedPage();
    const result = await execute(registry, adapter, HUMAN, "deploy.trigger", {
      targetName: "production",
      repoRoot: testRoot,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.value as {
      pageCount: number;
      fileCount: number;
      runId: string;
      buildId: string;
    };
    // P6.7.4 — the dev-owner seed now creates a `home` page, and other
    // tests / manual sessions can leave their own published pages
    // around. Assert that at least the test's page was emitted, not an
    // exact total. fileCount is 2 per published page (HTML + manifest)
    // plus the global robots, so we only sanity-check it grows with
    // pageCount.
    expect(out.pageCount).toBeGreaterThanOrEqual(1);
    expect(out.fileCount).toBeGreaterThanOrEqual(3);

    // P6.2 — files live under builds/<runId>; current symlink points there.
    const distDir = join(testRoot, "output", "production", "current");
    expect(existsSync(join(distDir, `${PAGE_SLUG}/index.html`))).toBe(true);
    const html = await readFile(join(distDir, `${PAGE_SLUG}/index.html`), "utf8");
    // P6.7 tagged outermost element with data-caelo-module-id; assert
    // by content + attribute presence rather than the literal opening tag.
    expect(html).toContain(">hello world</p>");
    expect(html).toContain("data-caelo-module-id=");
    expect(html).toContain("color:red");
    // P6.7 — the live-edit overlay's injected runtime (`caelo:ready` /
    // `caelo:element-clicked` / `caelo:reload`) must NEVER ship in the
    // deployed build. It only lives in the admin's preview endpoint at
    // /edit/preview/[pageId]. A regression here would expose every
    // visitor's site to a postMessage protocol for an internal tool.
    expect(html).not.toContain("caelo:ready");
    expect(html).not.toContain("caelo:element-clicked");
    expect(html).not.toContain("__caeloInjected");

    const robots = await readFile(join(distDir, "robots.txt"), "utf8");
    expect(robots).toContain("Allow: /");

    const manifestRaw = await readFile(join(distDir, "routing-manifest.json"), "utf8");
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.target).toBe("production");
    expect(manifest.pageCount).toBeGreaterThanOrEqual(1);
    expect(manifest.variants).toEqual([]);
    expect(manifest.runId).toBe(out.buildId);
  });

  it("staging deploy succeeds only when the serve layer serves THIS build (run #9 R10)", async () => {
    // Migration run #9 R10 (issue #262): deploy.trigger reported success
    // while the staging vhost served a months-old build (the generator
    // wrote outside the mounted directory). The op now round-trips
    // <CAELO_STAGING_BASE_URL>/routing-manifest.json and requires the
    // served runId to be the run just built. Serve the real output dir
    // here so the test exercises the check instead of skipping it.
    const stagingCurrent = join(testRoot, "output", "staging", "current");
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        const file = Bun.file(join(stagingCurrent, path));
        if (await file.exists()) return new Response(file);
        return new Response("not found", { status: 404 });
      },
    });
    process.env.CAELO_STAGING_BASE_URL = server.url.origin;
    try {
      const result = await execute(registry, adapter, HUMAN, "deploy.trigger", {
        targetName: "staging",
        repoRoot: testRoot,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const out = result.value as { runId: string; buildId: string; pageCount: number };

      // deploy_runs success implies the build's manifest write: the
      // served manifest must carry this run's id and a pageCount that
      // reflects the published pages that were built.
      const manifestRaw = await readFile(join(stagingCurrent, "routing-manifest.json"), "utf8");
      const manifest = JSON.parse(manifestRaw) as { runId: string; pageCount: number };
      expect(manifest.runId).toBe(out.buildId);
      expect(manifest.pageCount).toBe(out.pageCount);
      expect(manifest.pageCount).toBeGreaterThanOrEqual(1);

      const robots = await readFile(join(stagingCurrent, "robots.txt"), "utf8");
      expect(robots).toContain("Disallow: /");
    } finally {
      delete process.env.CAELO_STAGING_BASE_URL;
      server.stop(true);
    }
  });

  it("AI actor can trigger a deploy (trigger-only surface)", async () => {
    const result = await execute(registry, adapter, AI, "deploy.trigger", {
      targetName: "dev",
      repoRoot: testRoot,
    });
    expect(result.ok).toBe(true);
  });

  it("incremental deploy with changedPageIds re-bakes only those pages", async () => {
    // v0.2.80 regression — pre-fix this query failed inside a tx
    // with `Failed query: ... ANY(($1)::uuid[])` because drizzle's
    // bound-array interpolation through bun-sql doesn't translate
    // a JS array to PG's array_in cleanly. The cascade-driven Stage
    // (v0.2.79) was the first caller to actually exercise this code
    // path with a non-empty changedPageIds, so the regression was
    // invisible until then.
    //
    // Use the existing seeded page (the suite's previous tests
    // already ran seedPage). Look up its id via pages.list_by_status.
    const list = await execute(registry, adapter, HUMAN, "pages.list", {});
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const pages = (list.value as { pages: { id: string; slug: string }[] }).pages;
    const seeded = pages.find((p) => p.slug === PAGE_SLUG);
    expect(seeded).toBeDefined();
    if (!seeded) return;

    const result = await execute(registry, adapter, HUMAN, "deploy.trigger", {
      targetName: "production",
      repoRoot: testRoot,
      changedPageIds: [seeded.id],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.value as { pageCount: number };
    // Only the one whitelisted page should have been baked.
    expect(out.pageCount).toBe(1);
  });

  it("records a deploy_runs row with status=succeeded and counts", async () => {
    const runs = await execute(registry, adapter, HUMAN, "deploy.list_runs", { limit: 10 });
    expect(runs.ok).toBe(true);
    if (!runs.ok) return;
    const list = (
      runs.value as {
        runs: { status: string; pageCount: number | null; fileCount: number | null }[];
      }
    ).runs;
    expect(list.length).toBeGreaterThan(0);
    expect(list[0]?.status).toBe("succeeded");
    // See note above — other published pages may exist in the dev DB.
    expect(list[0]?.pageCount ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("staging deploy FAILS loudly when the serve layer serves a different build (run #9 R10)", async () => {
    // The regression itself: a serving layer stuck on a stale build.
    // Serve a manifest with a foreign runId; the op must mark the run
    // failed and return an error the Stage dialog can render — never a
    // success over a build the operator cannot see.
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/routing-manifest.json") {
          return new Response(
            JSON.stringify({ runId: "65d4201b-1dbf-43d7-90e8-18889c176127", pageCount: 1 }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    });
    process.env.CAELO_STAGING_BASE_URL = server.url.origin;
    try {
      const result = await execute(registry, adapter, HUMAN, "deploy.trigger", {
        targetName: "staging",
        repoRoot: testRoot,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("HandlerError");
      const message = "message" in result.error ? String(result.error.message) : "";
      expect(message).toContain("staging build verification failed");
      expect(message).toContain("CAELO_OUTPUT_ROOT");

      // The deploy_runs row must record the failure too — the Ops
      // dashboard is the audit surface for "why is staging stale?".
      const runs = await execute(registry, adapter, HUMAN, "deploy.list_runs", { limit: 1 });
      expect(runs.ok).toBe(true);
      if (!runs.ok) return;
      const latest = (runs.value as { runs: { status: string; errorMessage: string | null }[] })
        .runs[0];
      expect(latest?.status).toBe("failed");
      expect(latest?.errorMessage ?? "").toContain("staging build verification failed");
    } finally {
      delete process.env.CAELO_STAGING_BASE_URL;
      server.stop(true);
    }
  });

  it("staging deploy FAILS loudly when no published page serves the site root (issue #302)", async () => {
    // The guard itself: unpublish the fixture's root page so only
    // non-root pages ('p6-about') remain published. A full staging
    // build must fail in the generator — BEFORE any serve-layer
    // verification — with the actionable rename-to-'home' message.
    const list = await execute(registry, adapter, HUMAN, "pages.list", {});
    if (!list.ok) throw new Error("pages.list");
    const pages = (list.value as { pages: { id: string; slug: string }[] }).pages;
    const home = pages.find((p) => p.slug === HOME_SLUG);
    expect(home).toBeDefined();
    if (!home) return;
    const unpub = await execute(registry, adapter, HUMAN, "pages.update", {
      pageId: home.id,
      status: "draft",
    });
    if (!unpub.ok) throw new Error("unpublish home");
    try {
      const result = await execute(registry, adapter, HUMAN, "deploy.trigger", {
        targetName: "staging",
        repoRoot: testRoot,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("HandlerError");
      const message = "message" in result.error ? String(result.error.message) : "";
      expect(message).toContain("no page serves the site root");
      // The error must name the tool that actually exists. `change_page_slug`
      // was folded into `update_pages_many` (audit #3, PR #323).
      expect(message).toContain("update_pages_many");
    } finally {
      // Leave the fixture consistent for any test added after this one.
      await execute(registry, adapter, HUMAN, "pages.update", {
        pageId: home.id,
        status: "published",
      });
    }
  });
});
