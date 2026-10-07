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
 *     `/_assets/<slug>.<ext>` URL, with the bytes copied into the build.
 *
 * Also locks the generator's theme-asset URL shape: it used to build
 * `/_caelo/media/<uuid>` from the media id, which the media pass reads
 * as a SLUG and fails the deploy on as unresolved.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { generateSite, pageOutputPath } from "@caelo-cms/static-generator";
import { SQL } from "bun";
import { runMediaPipeline } from "../media/pipeline.js";
import { registerAdminOps } from "../register.js";
import { minimalIco } from "./fixtures/ico.js";
import { pinSiteBaseUrl } from "./fixtures/site-base-url.js";

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
/** Slug of the theme active before this test — re-activated after. */
let previousActiveSlug: string | null = null;
let restoreSiteBaseUrl: (() => Promise<void>) | null = null;
let mediaRoot = "";
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
  await cleanup();
  // #551: the generator refuses to build without a configured site URL.
  restoreSiteBaseUrl = await pinSiteBaseUrl(ADMIN_URL, "https://favicon-test.invalid");
  repoRoot = mkdtempSync(join(tmpdir(), `${PREFIX}-root-`));

  // A PNG favicon, with its orig bytes on disk where the generator's
  // media pass reads them (MEDIA_ROOT_DIR resolves against repoRoot).
  const upload = (await run("media.upload", {
    sha256: SHA,
    originalName: "favicon.png",
    name: "Tfavh Favicon",
    mime: "image/png",
    sizeBytes: 4,
    width: 32,
    height: 32,
    alt: "",
    storageKey: `${SHA}/orig.png`,
    variants: [
      {
        variant: "orig",
        format: "png",
        width: 32,
        height: 32,
        sizeBytes: 4,
        storageKey: `${SHA}/orig.png`,
      },
    ],
  })) as { assetId: string; slug: string };
  faviconId = upload.assetId;
  faviconSlug = upload.slug;
  mediaRoot = resolve(repoRoot, process.env.MEDIA_ROOT_DIR ?? "data/media");
  await mkdir(join(mediaRoot, SHA), { recursive: true });
  await writeFile(join(mediaRoot, SHA, "orig.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

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
  await restoreSiteBaseUrl?.();
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
  it("editor preview carries <link rel=icon> with the admin media URL + real mime", async () => {
    const out = (await run("pages.render_preview", { pageId })) as { html: string };
    expect(headOf(out.html)).toContain(
      `<link rel="icon" href="/_caelo/media/${faviconSlug}" type="image/png">`,
    );
    expect(out.html.split('rel="icon"').length - 1).toBe(1);
  });

  it("static build carries <link rel=icon> with the published /_assets URL and ships the file", async () => {
    const result = await adapter.withAdminTransaction(SYS_CTX, (tx) =>
      generateSite({
        tx,
        runId: crypto.randomUUID(),
        repoRoot,
        changedPageIds: [pageId],
        target: {
          id: crypto.randomUUID(),
          name: "favicon-test",
          env: "dev",
          outDir: "site",
          baseUrl: "https://favicon-test.invalid",
          robotsDefault: "noindex",
        },
      }),
    );
    const html = await readFile(join(result.buildDir, pageOutputPath(pagePath)), "utf8");
    expect(headOf(html)).toContain(
      `<link rel="icon" href="/_assets/${faviconSlug}.png" type="image/png">`,
    );
    expect(html).not.toContain("/_caelo/media");
    expect(html).not.toContain(faviconId);
    const shipped = await readFile(join(result.buildDir, "_assets", `${faviconSlug}.png`));
    expect(shipped.byteLength).toBe(4);
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
        tx,
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
    expect(headOf(html)).toContain(
      `<link rel="icon" href="/_assets/${upload.slug}.ico" type="image/x-icon">`,
    );
    const shipped = await readFile(join(result.buildDir, "_assets", `${upload.slug}.ico`));
    expect(new Uint8Array(shipped)).toEqual(ico);
  });
});
