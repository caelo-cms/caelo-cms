// SPDX-License-Identifier: MPL-2.0

/**
 * #1763 — /llms.txt in the build: absent unless a plugin switches it on,
 * then the indexable pages only (a noindex page and a page canonicalised
 * to another never appear), by page type, with title, URL and meta
 * description.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAdminOps } from "@caelo-cms/admin-core";
import { type BuildPluginServices, localBuildPluginServices } from "@caelo-cms/plugin-host";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { generateSite } from "./generate.js";
import { buildLlmsTxt, LLMS_TXT_FILE } from "./llms-txt.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "llms-txt-build-test",
};

const BASE = "https://llms.example";
const PFX = `llm-${Date.now().toString(36)}`;
let adapter: DatabaseAdapter;
let registry: OperationRegistry;
const ids: Record<"home" | "guide" | "copy", string> = { home: "", guide: "", copy: "" };
let before: {
  site_base_url: string | null;
  site_language: string | null;
  site_name: string | null;
};

async function asSystem<T>(query: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return query(tx as unknown as SQL);
    });
  } finally {
    await sql.end();
  }
}

async function page(slug: string, title: string, seo: Record<string, unknown>): Promise<string> {
  const tpl = (
    await asSystem((tx) => tx`SELECT id::text AS id FROM templates WHERE slug = ${`${PFX}-tpl`}`)
  )[0] as { id: string };
  const r = await execute(registry, adapter, SYSTEM, "pages.build_page", {
    page: { slug, title, templateId: tpl.id, status: "published" },
    modules: [
      {
        blockName: "content",
        displayName: `${PFX} ${slug}`,
        description: "Page body text.",
        kind: "content",
        html: "<h1>{{heading}}</h1>",
        fields: [{ name: "heading", kind: "text", label: "Heading" }],
        content: { source: "inline", values: { heading: title } },
      },
    ],
  });
  if (!r.ok) throw new Error(`build_page ${slug}: ${JSON.stringify(r.error)}`);
  const pageId = (r.value as { pageId: string }).pageId;
  const set = await execute(registry, adapter, SYSTEM, "pages_seo.set", { pageId, ...seo });
  if (!set.ok) throw new Error(`pages_seo.set ${slug}: ${JSON.stringify(set.error)}`);
  return pageId;
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  before = (
    await asSystem(
      (tx) => tx`SELECT site_base_url, site_language, site_name FROM site_defaults WHERE id = 1`,
    )
  )[0] as typeof before;
  await asSystem(
    (tx) =>
      tx`UPDATE site_defaults SET site_base_url = ${BASE}, site_language = 'en', site_name = 'Docs [Site]' WHERE id = 1`,
  );
  const tpl = await execute(registry, adapter, SYSTEM, "templates.create", {
    pageType: "home",
    slug: `${PFX}-tpl`,
    displayName: `${PFX} TPL`,
    html: `<html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
  });
  if (!tpl.ok) throw new Error(`template seed failed: ${JSON.stringify(tpl.error)}`);
  const templateId = (tpl.value as { templateId: string }).templateId;
  await execute(registry, adapter, SYSTEM, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  const home = await page(`${PFX}-home`, "Home", { metaDescription: "Docs for the product." });
  ids.home = home;
  const designated = await execute(registry, adapter, SYSTEM, "pages.set_home_page", {
    pageId: home,
  });
  if (!designated.ok) throw new Error(`set_home_page: ${JSON.stringify(designated.error)}`);
  ids.guide = await page(`${PFX}-guide`, "The [setup] guide", {
    metaDescription: "How to set it up,\nstep by step.",
  });
  await page(`${PFX}-hidden`, "Hidden page", { metaDescription: "Kept out.", noindex: true });
  ids.copy = await page(`${PFX}-copy`, "Copy of the guide", {
    metaDescription: "A copy.",
    canonicalUrl: `${BASE}/${PFX}-guide/`,
  });
});

afterAll(async () => {
  await asSystem(
    (tx) =>
      tx`UPDATE site_defaults SET site_base_url = ${before.site_base_url}, site_language = ${before.site_language}, site_name = ${before.site_name} WHERE id = 1`,
  );
  await adapter.close();
});

async function build(runId: string, plugins: BuildPluginServices): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "caelo-llms-txt-"));
  await adapter.withAdminTransaction(SYSTEM, (tx) =>
    generateSite({
      publishAt: new Date().toISOString(),
      tx,
      plugins,
      target: {
        id: "00000000-0000-0000-0000-0000000000b9",
        name: "production",
        env: "production",
        outDir: "out",
        baseUrl: BASE,
        robotsDefault: "index",
      },
      runId,
      repoRoot: root,
    }),
  );
  return join(root, "out", "builds", runId);
}

const switchedOn: BuildPluginServices = {
  ...localBuildPluginServices,
  resolveAgentFiles: async () => ({ llmsTxt: true, llmsTxtBy: ["seo"] }),
};

describe("llms.txt in the build", () => {
  it("is not written while no plugin switches it on", async () => {
    const dir = await build(`${PFX}-off`, localBuildPluginServices);
    expect(existsSync(join(dir, LLMS_TXT_FILE))).toBe(false);
  });

  it("lists the indexable, self-canonical pages with title, URL and description", async () => {
    const dir = await build(`${PFX}-on`, switchedOn);
    const text = await readFile(join(dir, LLMS_TXT_FILE), "utf8");
    // The site's name, and the home page's description as the summary.
    expect(text.startsWith("# Docs [Site]\n\n> Docs for the product.\n")).toBe(true);
    expect(text).toContain(`- [Home](${BASE}/): Docs for the product.`);
    expect(text).toContain(
      `- [The \\[setup\\] guide](${BASE}/${PFX}-guide/): How to set it up, step by step.`,
    );
    // A noindex page and a page canonicalised to another never appear.
    expect(text).not.toContain("Hidden page");
    expect(text).not.toContain("Copy of the guide");
    // Sections are page types.
    expect(text).toMatch(/\n## [^\n]+\n\n- \[/);
    const types = JSON.parse(await readFile(join(dir, "_content-types.json"), "utf8"));
    expect(types[LLMS_TXT_FILE]).toBe("text/plain; charset=utf-8");
  });

  it("an incremental build lists the pages it leaves alone from the live record", async () => {
    // The build rendered only the guide; the home page and the copy are
    // live as recorded, with what they were published with.
    const text = await adapter.withAdminTransaction(SYSTEM, (tx) =>
      buildLlmsTxt(
        tx,
        {
          indexedPages: async () => [
            {
              pageId: ids.guide,
              url: `${BASE}/${PFX}-guide/`,
              title: "The guide",
              metaDescription: "Now.",
            },
          ],
        },
        { siteBaseUrl: BASE, sitemap: true },
        [
          { pageId: ids.home, url: `${BASE}/`, title: "Home as published", summary: "Live text." },
          // Recorded at the guide's URL (its canonical points there): not its own address.
          { pageId: ids.copy, url: `${BASE}/${PFX}-guide/`, title: "Copy", summary: "x" },
          // A page row that is gone waits for the next full build.
          {
            pageId: "00000000-0000-4000-8000-00000000dead",
            url: `${BASE}/gone/`,
            title: "Gone",
            summary: "",
          },
        ],
      ),
    );
    expect(text).toContain(`- [The guide](${BASE}/${PFX}-guide/): Now.`);
    expect(text).toContain(`- [Home as published](${BASE}/): Live text.`);
    expect(text).toContain("> Live text.");
    expect(text).not.toContain("[Copy]");
    expect(text).not.toContain("Gone");
  });
});
