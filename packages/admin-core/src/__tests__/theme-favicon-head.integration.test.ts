// SPDX-License-Identifier: MPL-2.0

/**
 * Regression: binding a favicon to the theme (`themes.set_asset`, slot
 * `favicon`) put NO `<link rel="icon">` into the page — browsers probed
 * `/favicon.ico` and 404'd. The favicon is document metadata, so the
 * platform now emits it into <head> from the theme binding on both
 * surfaces:
 *   - editor preview (`pages.render_preview`): the admin media URL
 *     `/_caelo/media/<slug>`;
 *   - static generator (`generateSite`): the published
 *     `/_assets/<slug>.<hash>.<ext>` URL, with the bytes copied into the build.
 *
 * Also locks the generator's theme-asset URL shape: it used to build
 * `/_caelo/media/<uuid>` from the media id, which the media pass reads
 * as a SLUG and fails the deploy on as unresolved.
 *
 * Regression (LCP): a raster favicon linked its `orig` — an AI-generated
 * 1024 px PNG of 1-2 MB downloaded on every page load, which took the
 * homepage's Lighthouse LCP from 0.9 s to 4.7 s. Binding a raster favicon
 * now creates a 64 px PNG rendition (`icon-64`) and both surfaces link
 * that; a raster favicon without one fails the build loudly.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { localBuildPluginServices } from "@caelo-cms/plugin-host";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { FAVICON_VARIANT, FAVICON_VARIANT_PX } from "@caelo-cms/shared";
import { generateSite, pageOutputPath } from "@caelo-cms/static-generator";
import { Glob, SQL } from "bun";
import sharp from "sharp";
import { runMediaPipeline } from "../media/pipeline.js";
import { LocalVolumeAdapter, setMediaStorage } from "../media/storage.js";
import { setDeployBridge } from "../ops/deploy.js";
import { registerAdminOps } from "../register.js";
import { minimalIco } from "./fixtures/ico.js";
import { pinSiteBaseUrl } from "./fixtures/site-base-url.js";
import { pinSiteLanguage } from "./fixtures/site-language.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const PREFIX = "tfavh";
// media.upload keys on sha256; a recognisable prefix makes cleanup exact.
const SHA = `fa71c0de${"c".repeat(56)}`;
const PDF_SHA = `fa71c0de${"d".repeat(56)}`;
const ICO_SHA = `fa71c0de${"e".repeat(56)}`;
const SYS_CTX: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "theme-favicon-head",
};

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let repoRoot = "";
let pageId = "";
let pagePath = "";
let faviconId = "";
let faviconSlug = "";
/** Byte size of the large PNG favicon's original. */
let faviconOrigBytes = 0;
/** Slug of the theme active before this test — re-activated after. */
let previousActiveSlug: string | null = null;
let restoreSiteBaseUrl: (() => Promise<void>) | null = null;
let mediaRoot = "";
let restoreSiteLanguage: (() => Promise<void>) | null = null;
let prevSkipServeCheck: string | undefined;
/** The `home` page this test created (null when one existed). */
let createdHomeId: string | null = null;
const THEME_SLUG = `${PREFIX}-theme`;

async function run(name: string, input: unknown): Promise<unknown> {
  const r = await execute(registry, adapter, SYS_CTX, name, input);
  if (!r.ok) throw new Error(`${name} failed: ${JSON.stringify(r.error)}`);
  return r.value;
}

async function sqlSystem<T>(fn: (tx: Bun.SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as Bun.SQL);
    });
  } finally {
    await sql.end();
  }
}

async function cleanup(): Promise<void> {
  await sqlSystem(async (tx) => {
    await tx.unsafe(`DELETE FROM pages WHERE slug LIKE '${PREFIX}-%'`);
    await tx.unsafe(`DELETE FROM templates WHERE slug LIKE '${PREFIX}-%'`);
    await tx.unsafe(
      `DELETE FROM theme_snapshots WHERE theme_id IN (SELECT id FROM themes WHERE slug = '${THEME_SLUG}')`,
    );
    await tx.unsafe(`DELETE FROM themes WHERE slug = '${THEME_SLUG}' AND is_active = false`);
    await tx.unsafe(
      `DELETE FROM media_assets WHERE sha256 IN ('${SHA}', '${PDF_SHA}', '${ICO_SHA}')`,
    );
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  // Stage (deploy.trigger) runs the generator CLI through the bridge.
  setDeployBridge({ registry, adapter });
  prevSkipServeCheck = process.env.CAELO_SKIP_STAGING_SERVE_CHECK;
  process.env.CAELO_SKIP_STAGING_SERVE_CHECK = "1";
  await cleanup();
  // #551: the generator refuses to build without a configured site URL.
  restoreSiteBaseUrl = await pinSiteBaseUrl(ADMIN_URL, "https://favicon-test.invalid");
  restoreSiteLanguage = await pinSiteLanguage(ADMIN_URL, "en");
  repoRoot = mkdtempSync(join(tmpdir(), `${PREFIX}-root-`));

  // A large PNG favicon (the shape of a generate_image result: 1024 px,
  // noisy so it does not compress away), with its orig bytes on disk where
  // the generator's media pass reads them (MEDIA_ROOT_DIR resolves against
  // repoRoot) and where `themes.set_asset` reads them to make the rendition.
  const side = 1024;
  const noise = Buffer.alloc(side * side * 3);
  for (let i = 0; i < noise.length; i += 1) noise[i] = (i * 2654435761) >>> 24;
  const png = new Uint8Array(
    await sharp(noise, { raw: { width: side, height: side, channels: 3 } })
      .png()
      .toBuffer(),
  );
  faviconOrigBytes = png.byteLength;
  const upload = (await run("media.upload", {
    sha256: SHA,
    originalName: "favicon.png",
    name: "Tfavh Favicon",
    mime: "image/png",
    sizeBytes: png.byteLength,
    width: side,
    height: side,
    alt: "",
    storageKey: `${SHA}/orig.png`,
    variants: [
      {
        variant: "orig",
        format: "png",
        width: side,
        height: side,
        sizeBytes: png.byteLength,
        storageKey: `${SHA}/orig.png`,
      },
    ],
  })) as { assetId: string; slug: string };
  faviconId = upload.assetId;
  faviconSlug = upload.slug;
  mediaRoot = resolve(repoRoot, process.env.MEDIA_ROOT_DIR ?? "data/media");
  setMediaStorage(new LocalVolumeAdapter(mediaRoot));
  await mkdir(join(mediaRoot, SHA), { recursive: true });
  await writeFile(join(mediaRoot, SHA, "orig.png"), png);

  // A dedicated ACTIVE theme with a system-only font stack: the seeded
  // theme's body face is a web font, which would make the build depend on
  // fetching it over the network. Bind the favicon on it the way the
  // `set_theme_asset` tool does (active theme, no themeSlug).
  await run("themes.duplicate", {
    sourceSlug: "site-default",
    newSlug: THEME_SLUG,
    newDisplayName: "Favicon head test",
  });
  await run("themes.update_tokens", { themeSlug: THEME_SLUG, set: { fontBody: "serif" } });
  const active = await sqlSystem(
    (tx) =>
      tx.unsafe("SELECT slug FROM themes WHERE is_active = true LIMIT 1") as Promise<
        { slug: string }[]
      >,
  );
  previousActiveSlug = active[0]?.slug ?? null;
  await sqlSystem(async (tx) => {
    await tx.unsafe("UPDATE themes SET is_active = false WHERE is_active = true");
    await tx.unsafe(`UPDATE themes SET is_active = true WHERE slug = '${THEME_SLUG}'`);
  });
  await run("themes.set_asset", { slot: "favicon", mediaId: faviconId });

  const tpl = (await run("templates.create", {
    pageType: "home",
    slug: `${PREFIX}-tpl`,
    displayName: "Favicon head",
    html: `<body><caelo-slot name="content">_</caelo-slot></body>`,
  })) as { templateId: string };
  await run("template_blocks.set", {
    templateId: tpl.templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  const page = (await run("pages.create", {
    slug: `${PREFIX}-page`,
    title: "Favicon head",
    templateId: tpl.templateId,
  })) as { pageId: string };
  pageId = page.pageId;
  await run("pages.set_status", { pageId, status: "published" });
  // Staging builds refuse published pages without a meta description.
  await run("pages_seo.autofill", { pageId, metaDescription: "The favicon head page." });
  // A staging build needs a page at '/' (slug `home`); add one if the
  // database has none, and remove it again afterwards.
  const home = await sqlSystem(
    (tx) =>
      tx.unsafe("SELECT id::text AS id FROM pages WHERE slug = 'home' LIMIT 1") as Promise<
        { id: string }[]
      >,
  );
  if (home.length === 0) {
    const created = (await run("pages.create", {
      slug: "home",
      title: "Home",
      templateId: tpl.templateId,
    })) as { pageId: string };
    createdHomeId = created.pageId;
    await run("pages.set_status", { pageId: createdHomeId, status: "published" });
    await run("pages_seo.autofill", { pageId: createdHomeId, metaDescription: "Home." });
  }
  const rows = await sqlSystem(
    (tx) =>
      tx.unsafe(`SELECT current_path FROM pages WHERE id = '${pageId}'::uuid`) as Promise<
        { current_path: string }[]
      >,
  );
  pagePath = rows[0]?.current_path ?? "";
});

afterAll(async () => {
  if (previousActiveSlug !== null) {
    const slug = previousActiveSlug;
    await sqlSystem(async (tx) => {
      await tx.unsafe("UPDATE themes SET is_active = false WHERE is_active = true");
      await tx.unsafe(`UPDATE themes SET is_active = true WHERE slug = '${slug}'`);
    });
  }
  if (prevSkipServeCheck === undefined) delete process.env.CAELO_SKIP_STAGING_SERVE_CHECK;
  else process.env.CAELO_SKIP_STAGING_SERVE_CHECK = prevSkipServeCheck;
  if (createdHomeId !== null) {
    const id = createdHomeId;
    await sqlSystem((tx) => tx.unsafe(`DELETE FROM pages WHERE id = '${id}'::uuid`));
  }
  await restoreSiteBaseUrl?.();
  await restoreSiteLanguage?.();
  await cleanup();
  rmSync(repoRoot, { recursive: true, force: true });
  await adapter.close();
});

/** The `<head>…</head>` part of a document, so assertions can't pass on body markup. */
function headOf(html: string): string {
  const end = html.search(/<\/head\s*>/i);
  expect(end).toBeGreaterThan(-1);
  return html.slice(0, end);
}

describe("theme favicon is emitted into <head>", () => {
  it("binding a raster favicon creates its small PNG rendition", async () => {
    const rows = await sqlSystem(
      (tx) =>
        tx.unsafe(
          `SELECT format, width, height, size_bytes FROM media_variants
           WHERE asset_id = '${faviconId}'::uuid AND variant = '${FAVICON_VARIANT}'`,
        ) as Promise<{ format: string; width: number; height: number; size_bytes: number }[]>,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      format: "png",
      width: FAVICON_VARIANT_PX,
      height: FAVICON_VARIANT_PX,
    });
    expect(Number(rows[0]?.size_bytes)).toBeLessThan(faviconOrigBytes / 20);
  });

  it("editor preview carries <link rel=icon> with the rendition's admin media URL", async () => {
    const out = (await run("pages.render_preview", { pageId })) as { html: string };
    expect(headOf(out.html)).toContain(
      `<link rel="icon" href="/_caelo/media/${faviconSlug}/${FAVICON_VARIANT}" type="image/png">`,
    );
    expect(out.html).not.toContain(`/_caelo/media/${faviconSlug}"`);
    expect(out.html.split('rel="icon"').length - 1).toBe(1);
  });

  const build = (outDir: string) =>
    adapter.withAdminTransaction(SYS_CTX, (tx) =>
      generateSite({
        publishAt: new Date().toISOString(),
        tx,
        plugins: localBuildPluginServices,
        runId: crypto.randomUUID(),
        repoRoot,
        changedPageIds: [pageId],
        target: {
          id: crypto.randomUUID(),
          name: `favicon-${outDir}`,
          env: "dev",
          outDir,
          baseUrl: "https://favicon-test.invalid",
          robotsDefault: "noindex",
        },
      }),
    );

  it("static build links the published 64 px rendition, never the large original", async () => {
    const result = await build("site");
    const html = await readFile(join(result.buildDir, pageOutputPath(pagePath)), "utf8");
    // #667 — the published name carries the content hash.
    const href = headOf(html).match(
      new RegExp(
        `<link rel="icon" href="/(_assets/${faviconSlug}/${FAVICON_VARIANT}\\.[0-9a-f]{16}\\.png)" type="image/png">`,
      ),
    )?.[1];
    expect(href).toBeDefined();
    expect(html).not.toContain("/_caelo/media");
    expect(html).not.toContain(faviconId);
    const shipped = await readFile(join(result.buildDir, href as string));
    const meta = await sharp(shipped).metadata();
    expect(meta).toMatchObject({
      format: "png",
      width: FAVICON_VARIANT_PX,
      height: FAVICON_VARIANT_PX,
    });
    expect(shipped.byteLength).toBeLessThan(faviconOrigBytes / 20);
  });

  /** Drop the rendition: the state of a raster favicon bound before this release. */
  const dropRendition = () =>
    sqlSystem((tx) =>
      tx.unsafe(
        `DELETE FROM media_variants WHERE asset_id = '${faviconId}'::uuid AND variant = '${FAVICON_VARIANT}'`,
      ),
    );

  it("the generator alone never ships the large original: a missing rendition fails it loudly", async () => {
    await dropRendition();
    let failure = "";
    try {
      await build("site-stale");
    } catch (e) {
      failure = (e as Error).message;
    }
    expect(failure).toContain(`has no ${FAVICON_VARIANT} rendition`);
    expect(failure).toContain("themes.ensure_favicon_rendition");
  });

  it("a favicon bound before this release stages with no manual step and ships the 64x64 file", async () => {
    await dropRendition();
    const staged = (await run("deploy.trigger", { targetName: "staging", repoRoot })) as {
      runId: string;
    };
    expect(staged.runId).toBeTruthy();
    // The rendition was written once, from the stored original, and audited.
    const variants = await sqlSystem(
      (tx) =>
        tx.unsafe(
          `SELECT width, height FROM media_variants
           WHERE asset_id = '${faviconId}'::uuid AND variant = '${FAVICON_VARIANT}'`,
        ) as Promise<{ width: number; height: number }[]>,
    );
    expect(variants).toEqual([{ width: FAVICON_VARIANT_PX, height: FAVICON_VARIANT_PX }]);
    const audits = await sqlSystem(
      (tx) =>
        tx.unsafe(
          `SELECT result_summary FROM audit_events
           WHERE operation = 'themes.ensure_favicon_rendition' AND entity_id = '${faviconId}'`,
        ) as Promise<{ result_summary: string }[]>,
    );
    expect(audits.length).toBeGreaterThan(0);
    // The staged build links and ships the 64 px PNG.
    const shippedPaths = [
      ...new Glob(`**/_assets/${faviconSlug}/${FAVICON_VARIANT}.*.png`).scanSync({
        cwd: repoRoot,
      }),
    ];
    expect(shippedPaths.length).toBeGreaterThan(0);
    const shippedRel = shippedPaths[0] as string;
    const buildDir = join(repoRoot, shippedRel.slice(0, shippedRel.indexOf("/_assets/")));
    const html = await readFile(join(buildDir, pageOutputPath(pagePath)), "utf8");
    expect(headOf(html)).toContain(
      `<link rel="icon" href="/${shippedRel.slice(shippedRel.indexOf("_assets/"))}" type="image/png">`,
    );
    const meta = await sharp(await readFile(join(repoRoot, shippedRel))).metadata();
    expect(meta).toMatchObject({
      format: "png",
      width: FAVICON_VARIANT_PX,
      height: FAVICON_VARIANT_PX,
    });
    // A second Stage finds it in place: no second write.
    await run("deploy.trigger", { targetName: "staging", repoRoot });
    const again = await sqlSystem(
      (tx) =>
        tx.unsafe(
          `SELECT count(*)::int AS n FROM audit_events
           WHERE operation = 'themes.ensure_favicon_rendition' AND entity_id = '${faviconId}'`,
        ) as Promise<{ n: number }[]>,
    );
    expect(again[0]?.n).toBe(audits.length);
  });

  it("a Stage whose favicon original cannot be read fails loudly, recorded as a failed run", async () => {
    await dropRendition();
    const orig = join(mediaRoot, SHA, "orig.png");
    await rename(orig, `${orig}.away`);
    try {
      const r = await execute(registry, adapter, SYS_CTX, "deploy.trigger", {
        targetName: "staging",
        repoRoot,
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      const message = JSON.stringify(r.error);
      expect(message).toContain(`has no ${FAVICON_VARIANT} rendition`);
      expect(message).toContain("could not be made from the stored original");
      const failed = await sqlSystem(
        (tx) =>
          tx.unsafe(
            `SELECT status, error_message FROM deploy_runs WHERE error_message LIKE 'Blocked, favicon:%' ORDER BY started_at DESC LIMIT 1`,
          ) as Promise<{ status: string; error_message: string }[]>,
      );
      expect(failed[0]?.status).toBe("failed");
      expect(failed[0]?.error_message).toContain("Blocked, favicon:");
    } finally {
      await rename(`${orig}.away`, orig);
    }
    // Restored original: the next Stage repairs it.
    await run("deploy.trigger", { targetName: "staging", repoRoot });
  });

  it("refuses to bind a non-image asset to the favicon slot", async () => {
    // The bound favicon becomes `<link rel="icon" type="<mime>">` on every
    // page, so a PDF or video there would ship an unusable icon.
    const pdf = (await run("media.upload", {
      sha256: PDF_SHA,
      originalName: "brochure.pdf",
      name: "Tfavh Brochure",
      mime: "application/pdf",
      sizeBytes: 4,
      width: null,
      height: null,
      alt: "",
      storageKey: `${PDF_SHA}/orig.pdf`,
      variants: [
        {
          variant: "orig",
          format: "pdf",
          width: null,
          height: null,
          sizeBytes: 4,
          storageKey: `${PDF_SHA}/orig.pdf`,
        },
      ],
    })) as { assetId: string };
    const r = await execute(registry, adapter, SYS_CTX, "themes.set_asset", {
      slot: "favicon",
      mediaId: pdf.assetId,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(JSON.stringify(r.error)).toContain("not an image");
  });
  it("an uploaded .ico is stored as-is and becomes the favicon in preview and build as image/x-icon", async () => {
    // Same path an operator upload takes after sniffing: the pipeline
    // keeps the ICO byte-for-byte as the only (orig) variant.
    const ico = minimalIco();
    const pipeline = await runMediaPipeline(ICO_SHA, "image/x-icon", ico);
    expect(pipeline.variants.map((v) => v.variant)).toEqual(["orig"]);
    for (const v of pipeline.variants) {
      await mkdir(join(mediaRoot, ICO_SHA), { recursive: true });
      await writeFile(join(mediaRoot, v.storageKey), v.body);
    }
    const upload = (await run("media.upload", {
      sha256: ICO_SHA,
      originalName: "favicon.ico",
      name: "Tfavh Favicon Ico",
      mime: "image/x-icon",
      sizeBytes: ico.byteLength,
      width: pipeline.width,
      height: pipeline.height,
      alt: "",
      storageKey: pipeline.variants[0]?.storageKey ?? "",
      variants: pipeline.variants.map((v) => ({
        variant: v.variant,
        format: v.format,
        width: v.width,
        height: v.height,
        sizeBytes: v.sizeBytes,
        storageKey: v.storageKey,
      })),
    })) as { assetId: string; slug: string };
    // image/* → the favicon slot accepts it.
    await run("themes.set_asset", { slot: "favicon", mediaId: upload.assetId });

    const preview = (await run("pages.render_preview", { pageId })) as { html: string };
    expect(headOf(preview.html)).toContain(
      `<link rel="icon" href="/_caelo/media/${upload.slug}" type="image/x-icon">`,
    );

    const result = await adapter.withAdminTransaction(SYS_CTX, (tx) =>
      generateSite({
        publishAt: new Date().toISOString(),
        tx,
        plugins: localBuildPluginServices,
        runId: crypto.randomUUID(),
        repoRoot,
        changedPageIds: [pageId],
        target: {
          id: crypto.randomUUID(),
          name: "favicon-ico-test",
          env: "dev",
          outDir: "site-ico",
          baseUrl: "https://favicon-test.invalid",
          robotsDefault: "noindex",
        },
      }),
    );
    const html = await readFile(join(result.buildDir, pageOutputPath(pagePath)), "utf8");
    const icoHref = headOf(html).match(
      new RegExp(
        `<link rel="icon" href="/(_assets/${upload.slug}\\.[0-9a-f]{16}\\.ico)" type="image/x-icon">`,
      ),
    )?.[1];
    expect(icoHref).toBeDefined();
    const shipped = await readFile(join(result.buildDir, icoHref as string));
    expect(new Uint8Array(shipped)).toEqual(ico);
  });
});
