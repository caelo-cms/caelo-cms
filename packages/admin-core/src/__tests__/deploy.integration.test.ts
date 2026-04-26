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
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo/query-api";
import type { ExecutionContext } from "@caelo/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env["ADMIN_DATABASE_URL"];
const PUBLIC_URL = process.env["PUBLIC_ADMIN_DATABASE_URL"];
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

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM deploy_runs`;
      await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug = ${PAGE_SLUG})`;
      await tx`DELETE FROM pages WHERE slug = ${PAGE_SLUG}`;
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
    const out = result.value as { pageCount: number; fileCount: number; runId: string };
    expect(out.pageCount).toBe(1);
    // 1 page file + robots.txt + routing-manifest.json
    expect(out.fileCount).toBe(3);

    const distDir = join(testRoot, "output", "production");
    expect(existsSync(join(distDir, `${PAGE_SLUG}/index.html`))).toBe(true);
    const html = await readFile(join(distDir, `${PAGE_SLUG}/index.html`), "utf8");
    expect(html).toContain("<p>hello world</p>");
    expect(html).toContain("color:red");

    const robots = await readFile(join(distDir, "robots.txt"), "utf8");
    expect(robots).toContain("Allow: /");

    const manifestRaw = await readFile(join(distDir, "routing-manifest.json"), "utf8");
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.target).toBe("production");
    expect(manifest.pageCount).toBe(1);
    expect(manifest.variants).toEqual([]);
  });

  it("staging robots.txt blocks crawlers", async () => {
    const result = await execute(registry, adapter, HUMAN, "deploy.trigger", {
      targetName: "staging",
      repoRoot: testRoot,
    });
    expect(result.ok).toBe(true);
    const robots = await readFile(join(testRoot, "output", "staging", "robots.txt"), "utf8");
    expect(robots).toContain("Disallow: /");
  });

  it("AI actor can trigger a deploy (trigger-only surface)", async () => {
    const result = await execute(registry, adapter, AI, "deploy.trigger", {
      targetName: "dev",
      repoRoot: testRoot,
    });
    expect(result.ok).toBe(true);
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
    expect(list[0]?.pageCount).toBe(1);
  });
});
