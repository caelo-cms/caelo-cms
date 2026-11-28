// SPDX-License-Identifier: MPL-2.0

/**
 * #1762 — image entries in the sitemap: the library images an indexable
 * page ships, each once; an unpublished image (a Stage keeps its editor
 * URL), an image from elsewhere and the images of a noindex page are left
 * out. A sitemap without images keeps the plain namespace list.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localBuildPluginServices } from "@caelo-cms/plugin-host";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";
import { runSeoPass } from "./fixtures/seo-pass.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYS: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "sitemap-images-int",
};
const PFX = "t1762img";
const BASE = "https://img.example";
const HASH = "0123456789abcdef";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let buildDir = "";
const ids: Record<string, string> = {};

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM pages_seo WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}-%`})`;
      await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}-%`}`;
      await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE ${`${PFX}-%`})`;
      await tx`DELETE FROM templates WHERE slug LIKE ${`${PFX}-%`}`;
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
  buildDir = mkdtempSync(join(tmpdir(), "t1762-img-"));
  const tpl = await execute(registry, adapter, SYS, "templates.create", {
    pageType: "home",
    slug: `${PFX}-tpl`,
    displayName: "Img T",
    html: `<!doctype html><html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
    css: "",
  });
  if (!tpl.ok) throw new Error("tpl seed");
  const templateId = (tpl.value as { templateId: string }).templateId;
  for (const slug of ["gallery", "hidden", "plain"]) {
    const r = await execute(registry, adapter, SYS, "pages.create", {
      slug: `${PFX}-${slug}`,
      title: slug,
      templateId,
    });
    if (!r.ok) throw new Error(`page seed ${slug}`);
    ids[slug] = (r.value as { pageId: string }).pageId;
  }
  const hidden = await execute(registry, adapter, SYS, "pages_seo.set", {
    pageId: ids.hidden,
    noindex: true,
  });
  if (!hidden.ok) throw new Error("noindex seed");
});

afterAll(async () => {
  await wipe();
  rmSync(buildDir, { recursive: true, force: true });
  await adapter.close();
});

const shell = (body: string) => `<html><head><title>x</title></head><body>${body}</body></html>`;

async function sitemapOf(pages: { slug: string; body: string }[]): Promise<string> {
  await adapter.withAdminTransaction(SYS, async (tx) => {
    await runSeoPass({
      tx,
      plugins: localBuildPluginServices,
      buildDir,
      mediaRoot: buildDir,
      pages: pages.map((p) => ({
        pageId: ids[p.slug] as string,
        pageSlug: `${PFX}-${p.slug}`,
        html: shell(p.body),
      })),
      settings: { siteBaseUrl: BASE, sitemapEnabled: true, siteLanguage: "en", organization: {} },
      pageUrlStyle: "directory",
      notFoundPageId: null,
    });
  });
  return readFile(join(buildDir, "sitemap.xml"), "utf8");
}

describe("sitemap image entries", () => {
  it("lists the library images an indexable page ships, each once", async () => {
    const xml = await sitemapOf([
      {
        slug: "gallery",
        body: [
          `<img src="/_assets/team.${HASH}.jpg" alt="Team">`,
          `<img src="/_assets/team/webp-800.${HASH}.webp" alt="Team again">`,
          `<img src="/_assets/office/webp-1200.${HASH}.webp" alt="Office">`,
          // Not published by this build (a Stage reports it) and not ours.
          `<img src="/_caelo/media/draft-shot" alt="Draft">`,
          `<img src="https://cdn.other.example/x.jpg" alt="Elsewhere">`,
        ].join(""),
      },
      { slug: "hidden", body: `<img src="/_assets/secret.${HASH}.png" alt="Secret">` },
    ]);
    expect(xml).toContain('xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"');
    const locs = [...xml.matchAll(/<image:loc>([^<]+)<\/image:loc>/g)].map((m) => m[1]);
    expect(locs).toEqual([
      `${BASE}/_assets/team.${HASH}.jpg`,
      `${BASE}/_assets/office/webp-1200.${HASH}.webp`,
    ]);
    // The noindex page has no entry, so its images are not listed either.
    expect(xml).not.toContain("secret");
  });

  it("keeps the plain sitemap when no page shows a library image", async () => {
    const xml = await sitemapOf([{ slug: "plain", body: "<p>Text only.</p>" }]);
    expect(xml).not.toContain("xmlns:image");
    expect(xml).not.toContain("<image:image>");
    expect(xml).toContain(`<loc>${BASE}/${PFX}-plain/</loc>`);
  });
});
