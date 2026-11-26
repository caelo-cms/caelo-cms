// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 — a runtime-installed plugin adds hreflang alternates, og:locale,
 * sitemap alternates and default share images
 * (docs/dev/external-plugin-brokers.md §6.2), end to end on a real Postgres
 * and the real Deno sandbox: staged, approved by an Owner, activated, then
 * rendered by the editor preview and the build's SEO pass.
 *
 * - The entries come from the `$contributions` and `$shareImages` reserved
 *   entries. Alternates name pages by id; core builds every URL.
 * - Preview and build emit byte-identical contributed head blocks.
 * - Adversarial: a stylesheet `link`, a `robots` meta, an `href` instead of
 *   a page id, `javascript:` and markup in an `og:locale`, a page id no page
 *   has, more than 20 entries, an answer over 1 MB; a share image that is a
 *   reference image, a PDF or no asset. Each is refused, never rendered,
 *   and recorded as `plugin-value-refused` on both surfaces (the build's
 *   render failures, which Publish live refuses).
 *
 * The preview's cost with an external contributor is printed (PR measurement).
 */

import { afterAll, beforeAll, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  activateApprovedExternalPlugin,
  bootstrap,
  localBuildPluginServices,
  resetPluginHost,
} from "@caelo-cms/plugin-host";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import { lockPluginRow } from "../locks.js";
import { registerAdminOps } from "../register.js";
import { TEST_MEDIA_DIGEST } from "./fixtures/media-digest.js";
import { runSeoPass } from "./fixtures/seo-pass.js";
import { pinSiteBaseUrl } from "./fixtures/site-base-url.js";
import { pinSiteLanguage } from "./fixtures/site-language.js";

let adapter: DatabaseAdapter;
let pluginsRoot = "";
let buildDir = "";
let mediaRoot = "";
let restoreBase: (() => Promise<void>) | null = null;
let restoreLanguage: (() => Promise<void>) | null = null;
const registry = new OperationRegistry();
const system = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system" as const,
  requestId: "external-head-contributions-test",
};
const SLUG = "head-probe";
const PFX = "t1729hc";
const BASE = "https://example.com";
/** No page and no asset has this id. */
const NOWHERE = "00000000-0000-4000-8000-00000000dead";

/** The fixture's pages, by role. */
const page = { en: "", de: "", many: "", big: "", reference: "", pdf: "", gone: "" };
const asset = { library: "", reference: "", pdf: "" };

const manifest = {
  slug: SLUG,
  version: "1.0.0",
  tier: 2,
  schema: {},
  operations: ["head", "images"],
  contributes: ["head", "sitemap"],
  hasShareImages: true,
  requestedCapabilities: ["head_contributions"],
  capabilityReasons: { head_contributions: "Announce the language versions of a page" },
};

/** The plugin's source, with the fixture's page and asset ids written in. */
function source(): string {
  const ids = JSON.stringify({ page, asset, NOWHERE });
  return `const F = ${ids};
const alt = (hreflang, pageId) => ({ kind: "link", rel: "alternate", hreflang, pageId });
const versions = [alt("en", F.page.en), alt("de", F.page.de), alt("x-default", F.page.en)];
export default {slug:"${SLUG}",version:"1.0.0",tier:2,
  contributionsOperation: "head",
  shareImagesOperation: "images",
  operations: {
    head: async (ctx, args) => {
      if (args.pageIds.includes(F.page.big)) return { lang: { [F.page.big]: "x".repeat(1500000) } };
      const head = {}, sitemap = {}, lang = {};
      for (const id of args.pageIds) {
        if (id === F.page.many) {
          head[id] = Array.from({ length: 21 }, (_, i) => alt("x" + String.fromCharCode(97 + i), F.page.de));
          continue;
        }
        if (id !== F.page.en && id !== F.page.de) continue;
        head[id] = [
          ...versions,
          { kind: "meta", property: "og:locale", content: id === F.page.en ? "en_GB" : "de_DE" },
          { kind: "meta", property: "og:locale:alternate", content: id === F.page.en ? "de_DE" : "en_GB" },
          ...(id === F.page.en ? [
            { kind: "link", rel: "stylesheet", href: "https://evil.example/x.css" },
            { kind: "link", rel: "alternate", hreflang: "fr", href: "https://evil.example/fr" },
            { kind: "meta", name: "robots", content: "noindex" },
            { kind: "meta", property: "og:locale:alternate", content: "javascript:alert(1)" },
            { kind: "meta", property: "og:locale:alternate", content: "<script>alert(1)</script>" },
            alt("it", F.NOWHERE),
          ] : []),
        ];
        sitemap[id] = { alternates: versions.map((v) => ({ hreflang: v.hreflang, pageId: v.pageId })) };
        lang[id] = id === F.page.en ? "en" : "de";
      }
      return { head, sitemap, lang };
    },
    images: async (ctx, args) => {
      const of = { [F.page.en]: F.asset.library, [F.page.reference]: F.asset.reference,
        [F.page.pdf]: F.asset.pdf, [F.page.gone]: F.NOWHERE };
      return { images: Object.fromEntries(args.pageIds.filter((id) => of[id]).map((id) => [id, of[id]])) };
    },
  }};`;
}

async function call(
  name: string,
  input: unknown,
  ctx = system as { actorId: string; actorKind: "system" | "human" | "ai"; requestId: string },
) {
  const result = await execute(registry, adapter, ctx, name, input);
  if (!result.ok) throw new Error(`${name}: ${JSON.stringify(result.error)}`);
  return result.value;
}

/** The plugin's rows and this file's pages and media, which outlive the per-file reset. */
const cleanup = () =>
  adapter.withAdminTransaction(system, async (tx) => {
    await tx.execute(sql.raw("SET LOCAL caelo.actor_kind = 'system'"));
    await tx.execute(sql.raw(`DELETE FROM pages WHERE slug LIKE '${PFX}-%'`));
    await tx.execute(
      sql.raw(
        `DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE '${PFX}-%')`,
      ),
    );
    await tx.execute(sql.raw(`DELETE FROM templates WHERE slug LIKE '${PFX}-%'`));
    await tx.execute(
      sql.raw(
        `DELETE FROM media_variants WHERE asset_id IN (SELECT id FROM media_assets WHERE original_name LIKE '${PFX}-%')`,
      ),
    );
    await tx.execute(sql.raw(`DELETE FROM media_assets WHERE original_name LIKE '${PFX}-%'`));
  });

async function owner() {
  const id = crypto.randomUUID();
  await adapter.withAdminTransaction(system, async (tx) => {
    await tx.execute(
      sql`INSERT INTO actors (id,kind,display_name) VALUES (${id}::uuid,'human','owner')`,
    );
    await tx.execute(
      sql`INSERT INTO users (id,email,password_hash) VALUES (${id}::uuid,${`${id}@example.test`},'test-only')`,
    );
    await tx.execute(
      sql`INSERT INTO user_roles (user_id,role_id) SELECT ${id}::uuid,id FROM roles WHERE name='owner'`,
    );
  });
  return { ...system, actorId: id, actorKind: "human" as const };
}

/** Stage, approve as an Owner and activate the probe. */
async function install(): Promise<void> {
  const staged = (await call("plugins.stage_installation", { manifest, source: source() })) as {
    installationId: string;
    artifactDigest: string;
  };
  const review = (await call("plugins.list_installations", {})) as {
    installations: { id: string; currentStateDigest: string }[];
  };
  const item = review.installations.find((row) => row.id === staged.installationId);
  if (!item) throw new Error("review missing");
  await call(
    "plugins.approve_installation",
    {
      installationId: staged.installationId,
      artifactDigest: staged.artifactDigest,
      expectedStateDigest: item.currentStateDigest,
      capabilities: manifest.requestedCapabilities,
    },
    await owner(),
  );
  const loaded = await activateApprovedExternalPlugin(staged.installationId);
  if (!loaded.loaded) throw new Error(`activation failed: ${loaded.reason}`);
}

/** A media asset with a stored file (an image the build can publish). */
async function media(name: string, mime: "image/png" | "application/pdf"): Promise<string> {
  const sha256 = createHash("sha256").update(`${PFX}${name}`).digest("hex");
  const storageKey = `${PFX}/${sha256}.${mime === "image/png" ? "webp" : "pdf"}`;
  const file = join(mediaRoot, storageKey);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `bytes of ${name}`);
  const image = mime === "image/png";
  const { assetId } = (await call("media.upload", {
    sha256,
    originalName: `${PFX}-${name}.${image ? "png" : "pdf"}`,
    mime,
    sizeBytes: 10,
    width: image ? 1200 : null,
    height: image ? 630 : null,
    alt: name,
    storageKey,
    variants: [
      {
        variant: image ? "webp-1200" : "orig",
        format: image ? "webp" : "pdf",
        width: image ? 1200 : null,
        height: image ? 630 : null,
        sizeBytes: 10,
        storageKey,
        digest: TEST_MEDIA_DIGEST,
      },
    ],
  })) as { assetId: string };
  return assetId;
}

beforeAll(async () => {
  if (!process.env.ADMIN_DATABASE_URL || !process.env.PUBLIC_ADMIN_DATABASE_URL)
    throw new Error("DB URLs required");
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: process.env.ADMIN_DATABASE_URL,
    publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL,
  });
  registerAdminOps(registry);
  await cleanup();
  pluginsRoot = mkdtempSync(join(tmpdir(), "caelo-head-test-"));
  buildDir = mkdtempSync(join(tmpdir(), "caelo-head-build-"));
  mediaRoot = mkdtempSync(join(tmpdir(), "caelo-head-media-"));
  restoreBase = await pinSiteBaseUrl(process.env.ADMIN_DATABASE_URL, BASE);
  restoreLanguage = await pinSiteLanguage(process.env.ADMIN_DATABASE_URL, "en");
  await bootstrap({
    infra: { adapter, registry, lockPluginRow },
    pluginsRoot,
    systemActorId: system.actorId,
  });
  const { templateId } = (await call("templates.create", {
    pageType: "home",
    slug: `${PFX}-tpl`,
    displayName: "T1729HC",
    html: `<body><caelo-slot name="content">_</caelo-slot></body>`,
  })) as { templateId: string };
  await call("template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  for (const role of Object.keys(page) as (keyof typeof page)[]) {
    page[role] = (
      (await call("pages.create", {
        slug: `${PFX}-${role}`,
        title: role,
        templateId,
        status: "published",
      })) as { pageId: string }
    ).pageId;
  }
  asset.library = await media("library", "image/png");
  asset.reference = await media("reference", "image/png");
  await call("media.set_visibility", { assetId: asset.reference, visibility: "reference" });
  asset.pdf = await media("pdf", "application/pdf");
  await install();
}, 180_000);

afterAll(async () => {
  resetPluginHost();
  await cleanup();
  await restoreBase?.();
  await restoreLanguage?.();
  await adapter.close();
  for (const dir of [pluginsRoot, buildDir, mediaRoot])
    rmSync(dir, { recursive: true, force: true });
});

interface Preview {
  html: string;
  missingSlots: string[];
  pluginFailures: { slug: string; reason: string }[];
}
const preview = async (pageId: string) =>
  (await call("pages.render_preview", { pageId })) as Preview;

/** The contributed part of a head: every alternate and og:locale line, in order. */
function contributedBlock(html: string): string {
  return (
    html.match(/<link rel="alternate" hreflang=[^>]*>|<meta property="og:locale[^>]*>/g) ?? []
  ).join("\n");
}

const refused = (point: string, field: string, rule: string) =>
  `plugin-value-refused:${SLUG}.${point}.${field}:${rule}`;

it("preview and build emit the same checked head, URLs built by core, refusals recorded", async () => {
  const started = performance.now();
  const en = await preview(page.en);
  const previewMs = performance.now() - started;
  expect(en.pluginFailures).toEqual([]);
  const expected = [
    `<link rel="alternate" hreflang="de" href="${BASE}/${PFX}-de/" />`,
    `<link rel="alternate" hreflang="en" href="${BASE}/${PFX}-en/" />`,
    `<link rel="alternate" hreflang="x-default" href="${BASE}/${PFX}-en/" />`,
    '<meta property="og:locale" content="en_GB" />',
    '<meta property="og:locale:alternate" content="de_DE" />',
  ].join("\n");
  expect(contributedBlock(en.html)).toBe(expected);
  expect(en.html).toStartWith('<!doctype html><html lang="en"');
  for (const banned of ["stylesheet", "evil.example", "noindex", "javascript:", "<script>alert"]) {
    expect(en.html).not.toContain(banned);
  }
  const enRefusals = [
    refused("head-composition", "link", "rel-stylesheet"),
    refused("head-composition", "link", "href-not-allowed"),
    refused("head-composition", "meta", "name-robots"),
    refused("head-composition", "meta", "content-format"),
    refused("head-composition", "link", "page-unknown"),
  ];
  for (const marker of enRefusals) expect(en.missingSlots).toContain(marker);
  // The library image is the page's share image.
  expect(en.html).toMatch(/<meta property="og:image" content="[^"]+"/);

  const de = await preview(page.de);
  expect(de.missingSlots.filter((m) => m.startsWith("plugin-value-refused:"))).toEqual([]);

  const built = [page.en, page.de].map((pageId, i) => ({
    pageId,
    pageSlug: `${PFX}-${i === 0 ? "en" : "de"}`,
    html: "<html><head><title>x</title></head><body>b</body></html>",
  }));
  const { renderFailures } = await adapter.withAdminTransaction(system, (tx) =>
    runSeoPass({
      tx,
      plugins: localBuildPluginServices,
      buildDir,
      mediaRoot,
      pages: built,
      settings: { siteBaseUrl: BASE, sitemapEnabled: true, siteLanguage: "en", organization: {} },
      pageUrlStyle: "directory",
      notFoundPageId: null,
      unresolved: "report",
    }),
  );
  // Byte parity: the build's contributed block is the preview's.
  expect(contributedBlock(built[0]?.html ?? "")).toBe(expected);
  expect(contributedBlock(built[1]?.html ?? "")).toBe(contributedBlock(de.html));
  expect(built[0]?.html).toStartWith('<html lang="en">');
  expect(built[1]?.html).toStartWith('<html lang="de">');
  // The build records what was refused: a Stage reports it, Publish live refuses it.
  expect(renderFailures.map((f) => f.reason).sort()).toEqual([...enRefusals].sort());
  expect(renderFailures.every((f) => f.pageId === page.en)).toBe(true);

  const again = performance.now();
  await preview(page.en);
  console.log(
    `[measure] preview with an external head contributor: first ${previewMs.toFixed(0)} ms, second ${(performance.now() - again).toFixed(0)} ms`,
  );
}, 120_000);

it("more than 20 entries on a page, or an answer over 1 MB, contributes nothing and is recorded", async () => {
  const many = await preview(page.many);
  expect(contributedBlock(many.html)).toBe("");
  expect(many.missingSlots).toContain(refused("head-composition", "entries", "entries-over-limit"));
  const big = await preview(page.big);
  expect(big.pluginFailures).toEqual([]);
  expect(contributedBlock(big.html)).toBe("");
  expect(big.missingSlots).toContain(refused("head-composition", "answer", "answer-too-large"));
}, 120_000);

it("a share image must be an existing library image; any other shows none and is recorded", async () => {
  const cases: [string, string][] = [
    [page.reference, "media-reference"],
    [page.pdf, "media-not-image"],
    [page.gone, "media-missing"],
  ];
  for (const [pageId, rule] of cases) {
    const p = await preview(pageId);
    // Not the site default either: the page shows no share image.
    expect(p.html).not.toContain("og:image");
    expect(p.missingSlots).toContain(refused("share-images", "image", rule));
  }
  const { pages: reads } = (await call("pages_seo.get_many", {
    pageIds: [page.reference],
  })) as { pages: { shareImage: { source: string; assetId: string | null; refused?: string } }[] };
  expect(reads[0]?.shareImage).toEqual({
    source: "language",
    assetId: asset.reference,
    url: null,
    refused: refused("share-images", "image", "media-reference"),
  });

  const built = cases.map(([pageId]) => ({
    pageId,
    pageSlug: pageId,
    html: "<html><head><title>x</title></head><body>b</body></html>",
  }));
  const { renderFailures } = await adapter.withAdminTransaction(system, (tx) =>
    runSeoPass({
      tx,
      plugins: localBuildPluginServices,
      buildDir,
      mediaRoot,
      pages: built,
      settings: { siteBaseUrl: BASE, sitemapEnabled: false, siteLanguage: "en", organization: {} },
      pageUrlStyle: "directory",
      notFoundPageId: null,
      unresolved: "report",
    }),
  );
  for (const b of built) expect(b.html).not.toContain("og:image");
  expect(renderFailures.map((f) => f.reason).sort()).toEqual(
    cases.map(([, rule]) => refused("share-images", "image", rule)).sort(),
  );
}, 120_000);
