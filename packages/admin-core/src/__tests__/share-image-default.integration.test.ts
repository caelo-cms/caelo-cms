// SPDX-License-Identifier: MPL-2.0

/**
 * #1452 — the site's default share image. A page without its own image
 * shows its language's default, else the active theme's `socialShare` slot;
 * its own image always wins, and nothing lands on the page's SEO row.
 * Asserted on all three surfaces that must agree: the build's SEO pass, the
 * editor preview and the SEO reads behind `get_page_seo` and the editor.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bootstrap, localBuildPluginServices, runPluginOperation } from "@caelo-cms/plugin-host";
import intlPlugin from "@caelo-cms/plugin-international-site";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";
import { TEST_MEDIA_DIGEST } from "./fixtures/media-digest.js";
import { runSeoPass } from "./fixtures/seo-pass.js";
import { pinSiteBaseUrl } from "./fixtures/site-base-url.js";
import { pinSiteLanguage } from "./fixtures/site-language.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SYS: ExecutionContext = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system",
  requestId: "t1452",
};
const BASE = "https://example.com";
const PFX = `t1452-${Date.now().toString(36)}-`;

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let templateId: string;
let buildDir: string;
let mediaRoot: string;
let restoreBase: (() => Promise<void>) | null = null;
let restoreLanguage: (() => Promise<void>) | null = null;
let siteImage: { assetId: string; slug: string };
let ownImage: { assetId: string; slug: string };
let germanImage: { assetId: string; slug: string };

async function withSql<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return (await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as SQL);
    })) as T;
  } finally {
    await sql.end();
  }
}

async function op<T>(name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, SYS, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function intl<T>(operationName: string, args: unknown): Promise<T> {
  const r = await runPluginOperation({
    invocation: { origin: "system", actorId: "00000000-0000-0000-0000-000000000000" },
    pluginSlug: "international-site",
    operationName,
    args,
  });
  if (!r.ok) throw new Error(`${operationName}: ${r.error.kind}: ${r.error.message}`);
  return r.value as T;
}

/** A library image with its stored file, as the build's media pass reads it. */
async function image(name: string): Promise<{ assetId: string; slug: string }> {
  const sha256 = createHash("sha256").update(`${PFX}${name}`).digest("hex");
  const storageKey = `t1452/${sha256}.webp`;
  const file = join(mediaRoot, storageKey);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `bytes of ${name}`);
  const up = await op<{ assetId: string }>("media.upload", {
    sha256,
    originalName: `${PFX}${name}.png`,
    mime: "image/png",
    sizeBytes: 10,
    width: 1200,
    height: 630,
    alt: name,
    storageKey,
    variants: [
      {
        variant: "webp-1200",
        format: "webp",
        width: 1200,
        height: 630,
        sizeBytes: 10,
        storageKey,
        digest: TEST_MEDIA_DIGEST,
      },
    ],
  });
  const { asset } = await op<{ asset: { slug: string } }>("media.get", { assetId: up.assetId });
  return { assetId: up.assetId, slug: asset.slug };
}

async function page(slug: string): Promise<string> {
  const { pageId } = await op<{ pageId: string }>("pages.create", {
    slug: `${PFX}${slug}`,
    title: slug,
    templateId,
    status: "published",
  });
  return pageId;
}

const bindSiteImage = (mediaId: string | null) =>
  op("themes.set_asset", { slot: "socialShare", mediaId });

async function buildHead(pageId: string, siteShareImageAssetId: string | null): Promise<string> {
  const built = {
    pageId,
    pageSlug: "x",
    html: "<html><head><title>x</title></head><body>b</body></html>",
  };
  await adapter.withAdminTransaction(SYS, (tx) =>
    runSeoPass({
      tx,
      plugins: localBuildPluginServices,
      buildDir,
      mediaRoot,
      pages: [built],
      settings: { siteBaseUrl: BASE, sitemapEnabled: false, siteLanguage: "en", organization: {} },
      pageUrlStyle: "directory",
      notFoundPageId: null,
      siteShareImageAssetId,
    }),
  );
  return built.html;
}

interface SeoRead {
  seo: { ogImageAssetId: string | null } | null;
  shareImage: { source: string; assetId: string | null; url: string | null };
}

async function readSeo(pageId: string): Promise<SeoRead> {
  const { pages } = await op<{ pages: SeoRead[] }>("pages_seo.get_many", { pageIds: [pageId] });
  const read = pages[0];
  if (!read) throw new Error("no page read");
  return read;
}

async function previewHtml(pageId: string): Promise<string> {
  return (await op<{ html: string }>("pages.render_preview", { pageId })).html;
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  buildDir = mkdtempSync(join(tmpdir(), "t1452-build-"));
  mediaRoot = mkdtempSync(join(tmpdir(), "t1452-media-"));
  restoreBase = await pinSiteBaseUrl(ADMIN_URL, BASE);
  restoreLanguage = await pinSiteLanguage(ADMIN_URL, "en");
  const report = await bootstrap({
    infra: { adapter, registry },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: intlPlugin }],
  });
  if (report.failed.length > 0) throw new Error(JSON.stringify(report.failed));
  const tpl = await op<{ templateId: string }>("templates.create", {
    pageType: "home",
    slug: `${PFX}tpl`,
    displayName: "T1452",
    html: `<body><caelo-slot name="content">_</caelo-slot></body>`,
  });
  templateId = tpl.templateId;
  await op("template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  siteImage = await image("site");
  ownImage = await image("own");
  germanImage = await image("german");
  await intl("set_locales", {
    locales: [
      { code: "en", displayName: "English", urlStrategy: "none", isDefault: true },
      { code: "de", displayName: "Deutsch", urlStrategy: "subdirectory", isDefault: false },
    ],
  });
});

afterAll(async () => {
  await bindSiteImage(null);
  await restoreBase?.();
  await restoreLanguage?.();
  await adapter.close();
  rmSync(buildDir, { recursive: true, force: true });
  rmSync(mediaRoot, { recursive: true, force: true });
});

describe("#1452 — default share image", () => {
  it("with no default a page ships without og:image, and every surface says so", async () => {
    await bindSiteImage(null);
    const p = await page("none");
    const html = await buildHead(p, null);
    expect(html).not.toContain("og:image");
    expect(html).toContain('name="twitter:card" content="summary"');
    expect((await readSeo(p)).shareImage).toEqual({ source: "none", assetId: null, url: null });
    expect(await previewHtml(p)).not.toContain("og:image");
  });

  it("the theme's socialShare slot is the default on every surface, and nothing lands on the page", async () => {
    await bindSiteImage(siteImage.assetId);
    const p = await page("site");

    const html = await buildHead(p, siteImage.assetId);
    expect(html).toMatch(
      new RegExp(`property="og:image" content="${BASE}/_assets/${siteImage.slug}`),
    );
    expect(html).toContain('name="twitter:card" content="summary_large_image"');

    const read = await readSeo(p);
    expect(read.shareImage.source).toBe("site");
    expect(read.shareImage.assetId).toBe(siteImage.assetId);
    expect(read.shareImage.url).toContain(siteImage.slug);
    // Fill-once rule: a default is read at render time, never stored.
    expect(read.seo?.ogImageAssetId ?? null).toBeNull();

    const { images } = await op<{ images: { pageId: string; source: string }[] }>(
      "pages_seo.share_images",
      { pageIds: [p] },
    );
    expect(images).toEqual([expect.objectContaining({ pageId: p, source: "site" })]);
    expect(await previewHtml(p)).toContain(
      `property="og:image" content="/_caelo/media/${siteImage.slug}`,
    );
  });

  it("a page's own image wins over the default", async () => {
    await bindSiteImage(siteImage.assetId);
    const p = await page("own");
    await op("pages_seo.set", { pageId: p, ogImageAssetId: ownImage.assetId });

    const html = await buildHead(p, siteImage.assetId);
    expect(html).toContain(`_assets/${ownImage.slug}`);
    expect(html).not.toContain(`_assets/${siteImage.slug}`);
    expect((await readSeo(p)).shareImage).toMatchObject({
      source: "page",
      assetId: ownImage.assetId,
    });
    expect(await previewHtml(p)).toContain(`/_caelo/media/${ownImage.slug}`);
  });

  it("a language's default beats the site default for its pages only; clearing it falls back to the site", async () => {
    await bindSiteImage(siteImage.assetId);
    const german = await page("de-page");
    const english = await page("en-page");
    await intl("link_page_variants", { groupPageId: english, pageId: german, localeCode: "de" });
    await intl("set_locale_share_image", { localeCode: "de", mediaId: germanImage.assetId });

    expect((await readSeo(german)).shareImage).toMatchObject({
      source: "language",
      assetId: germanImage.assetId,
    });
    expect((await readSeo(english)).shareImage.source).toBe("site");
    expect(await buildHead(german, siteImage.assetId)).toContain(`_assets/${germanImage.slug}`);
    expect(await previewHtml(german)).toContain(`/_caelo/media/${germanImage.slug}`);
    expect(
      (await intl<{ shareImages: Record<string, string> }>("intl_status", {})).shareImages,
    ).toEqual({ de: germanImage.assetId });

    await intl("set_locale_share_image", { localeCode: "de", mediaId: null });
    expect((await readSeo(german)).shareImage.source).toBe("site");
  });

  it("refuses a language default for an unknown language or image, naming the next step", async () => {
    await expect(
      intl("set_locale_share_image", { localeCode: "fr", mediaId: germanImage.assetId }),
    ).rejects.toThrow(/not registered/);
    await expect(
      intl("set_locale_share_image", {
        localeCode: "de",
        mediaId: "0a7f3f2e-58d1-4c55-9a7a-3e6f0f0c1d2e",
      }),
    ).rejects.toThrow(/find_media/);
  });

  it("a default whose image was deleted is flagged on the reads and stops the build", async () => {
    const doomed = await image("doomed");
    await bindSiteImage(doomed.assetId);
    await withSql((tx) =>
      tx.unsafe(`UPDATE media_assets SET deleted_at = now() WHERE id = '${doomed.assetId}'`),
    );
    const p = await page("deleted");
    expect((await readSeo(p)).shareImage).toEqual({
      source: "site",
      assetId: doomed.assetId,
      url: null,
    });
    await expect(buildHead(p, doomed.assetId)).rejects.toThrow(/set_theme_asset slot socialShare/);
  });
});
