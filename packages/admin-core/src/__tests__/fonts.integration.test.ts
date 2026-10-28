// SPDX-License-Identifier: MPL-2.0

import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fontMetadata, fontReader } from "@caelo-cms/font-service";
import { localBuildPluginServices } from "@caelo-cms/plugin-host";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { applyDtcgWrites, type ExecutionContext, type ThemeDocument } from "@caelo-cms/shared";
import { generateSite, loadSiteFontUsage, resolveThemeFonts } from "@caelo-cms/static-generator";
import { sql } from "drizzle-orm";
import { registerAdminOps } from "../register.js";
import { pinSiteBaseUrl } from "./fixtures/site-base-url.js";
import { pinSiteLanguage } from "./fixtures/site-language.js";

const adapter = new DatabaseAdapter({
  adminDatabaseUrl: process.env.ADMIN_DATABASE_URL!,
  publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL!,
});
const THEME_SLUG = `font-service-${crypto.randomUUID().slice(0, 8)}`;
const registry = new OperationRegistry();
registerAdminOps(registry);
const ctx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "fonts-test",
};
const data = readFileSync(
  new URL("../../../font-service/src/fixtures/NotoSans-Regular.base64.txt", import.meta.url),
  "utf8",
).trim();
const license = {
  name: "OFL-1.1",
  text: readFileSync(
    new URL("../../../font-service/src/fixtures/OFL.txt", import.meta.url),
    "utf8",
  ),
  webEmbedding: true,
  documentEmbedding: true,
};
async function run(name: string, input: unknown, identity = ctx) {
  const result = await execute(registry, adapter, identity, name, input);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
let restoreSiteBaseUrl: (() => Promise<void>) | null = null;
let restoreSiteLanguage: (() => Promise<void>) | null = null;
beforeAll(async () => {
  // #551 — the build half of the parity check needs a configured base URL.
  restoreSiteBaseUrl = await pinSiteBaseUrl(process.env.ADMIN_DATABASE_URL!, "https://example.com");
  restoreSiteLanguage = await pinSiteLanguage(process.env.ADMIN_DATABASE_URL!, "en");
});
afterAll(async () => {
  await restoreSiteBaseUrl?.();
  await restoreSiteLanguage?.();
  await adapter.withAdminTransaction(ctx, async (tx) => {
    await tx.execute(
      sql`DELETE FROM theme_snapshots WHERE theme_id IN (SELECT id FROM themes WHERE slug=${THEME_SLUG})`,
    );
    await tx.execute(sql`DELETE FROM themes WHERE slug=${THEME_SLUG}`);
    await tx.execute(
      sql`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug='home' AND template_id IN (SELECT id FROM templates WHERE slug=${`${THEME_SLUG}-tpl`}))`,
    );
    await tx.execute(
      sql`DELETE FROM pages WHERE template_id IN (SELECT id FROM templates WHERE slug=${`${THEME_SLUG}-tpl`})`,
    );
    await tx.execute(
      sql`DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE display_name=${`${THEME_SLUG} body`})`,
    );
    await tx.execute(sql`DELETE FROM modules WHERE display_name=${`${THEME_SLUG} body`}`);
    await tx.execute(
      sql`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug=${`${THEME_SLUG}-tpl`})`,
    );
    await tx.execute(sql`DELETE FROM templates WHERE slug=${`${THEME_SLUG}-tpl`}`);
  });
  await adapter.close();
});
test("immutable core files: import, inspect, find, resolve, chunked read, exact preview/build parity and RLS", async () => {
  const font = fontMetadata.parse(
    await run("fonts.import", { dataBase64: data, license, source: "test:fixture" }),
  );
  const ref = { id: font.id, sha256: font.sha256 };
  expect(await run("fonts.inspect", ref)).toEqual(font);
  expect(
    ((await run("fonts.find", { query: "Noto" })) as { fonts: unknown[] }).fonts,
  ).toContainEqual(font);
  expect(
    await run("fonts.resolve", { ...ref, use: "document", text: "Grüße", formats: ["woff"] }),
  ).toEqual(font);
  await expect(
    run("fonts.resolve", { ...ref, use: "document", text: "🦄", formats: ["woff"] }),
  ).rejects.toThrow("FontMissingCharacters");
  await expect(run("fonts.resolve", { ...ref, use: "document", formats: ["ttf"] })).rejects.toThrow(
    "FontFormatNotSupportedByConsumer",
  );
  await expect(run("fonts.inspect", { ...ref, sha256: "0".repeat(64) })).rejects.toThrow(
    "FontRevisionNotFound",
  );
  await expect(run("fonts.read_chunk", { ...ref, offset: 0, length: 262145 })).rejects.toThrow(
    "ValidationFailed",
  );
  expect(
    (
      (await run("fonts.read_chunk", { ...ref, offset: 0, length: 262144 })) as {
        dataBase64: string;
      }
    ).dataBase64,
  ).toBe(data);
  expect(
    (
      await execute(
        registry,
        adapter,
        { ...ctx, actorKind: "plugin", pluginId: crypto.randomUUID() },
        "fonts.inspect",
        ref,
      )
    ).ok,
  ).toBe(false);
  const revision = fontMetadata.parse(
    await run("fonts.import", {
      dataBase64: data,
      license: { ...license, documentEmbedding: false },
      source: "test:reimport",
    }),
  );
  expect(revision.id).not.toBe(font.id);
  expect(revision.sha256).toBe(font.sha256);
  await expect(
    run("fonts.resolve", {
      id: revision.id,
      sha256: revision.sha256,
      use: "document",
      formats: ["woff"],
    }),
  ).rejects.toThrow("FontEmbeddingNotPermitted");
  const duplicate = (await run("themes.duplicate", {
    sourceSlug: "site-default",
    newSlug: THEME_SLUG,
    newDisplayName: "Font service test",
  })) as { theme: { id: string } };
  expect(duplicate).toBeDefined();
  await run("themes.update_tokens", {
    themeSlug: THEME_SLUG,
    fontBindings: { body: ref, heading: ref, mono: ref, display: ref },
  });
  const themeResult = (await run("themes.get", { slug: THEME_SLUG })) as {
    theme: { tokens: ThemeDocument };
  };
  const tokens = themeResult.theme.tokens;
  const updated = applyDtcgWrites(
    tokens,
    { "typography.body": { fontSize: "18px" } },
    { "typography.body": "typography" },
  );
  expect(
    (updated.typography as Record<string, { $extensions: unknown }>).body?.$extensions,
  ).toEqual({ "caelo.font": ref });
  // Restore an earlier complete theme document through the same public import
  // operation used by the editor. Both file and license revisions survive.
  await run("themes.update_tokens", { themeSlug: THEME_SLUG, set: { fontBody: "serif" } });
  await run("themes.import", { themeSlug: THEME_SLUG, tokens });
  expect(
    ((await run("themes.get", { slug: THEME_SLUG })) as { theme: { tokens: ThemeDocument } }).theme
      .tokens,
  ).toEqual(tokens);
  // One published page so the build emits HTML carrying the @font-face CSS.
  const template = (await run("templates.create", {
    slug: `${THEME_SLUG}-tpl`,
    displayName: `${THEME_SLUG} template`,
    html: `<html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
  })) as { templateId: string };
  await run("template_blocks.set", {
    templateId: template.templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  const built = (await run("pages.build_page", {
    page: { slug: "home", title: "Fonts", templateId: template.templateId, status: "published" },
    modules: [
      {
        blockName: "content",
        displayName: `${THEME_SLUG} body`,
        description: "Page body text.",
        kind: "content",
        html: '<p class="body">{{body_text}}</p>',
        fields: [{ name: "body_text", kind: "text", label: "Body" }],
        content: { source: "inline", values: { body_text: "Grüße" } },
      },
    ],
  })) as { pageId: string };
  const cacheDir = await mkdtemp(join(tmpdir(), "font-service-test-"));
  try {
    await adapter.withAdminTransaction(ctx, async (tx) => {
      const preview = await resolveThemeFonts({
        tokens,
        cacheDir,
        publicBasePath: "/_caelo/fonts",
        readFont: fontReader(tx),
        loadFontUsage: () => loadSiteFontUsage(tx, tokens),
        preloadLanguage: null,
        fetcher: (() => {
          throw new Error("Unexpected font network fetch");
        }) as typeof fetch,
      });
      expect(preview.unresolved).toEqual([]);
      expect(preview.css).toContain(font.cssFamily);
      // The fixture covers Latin + Vietnamese: two WOFF2 slices + the license.
      expect(preview.files.map((f) => f.relPath).filter((p) => p.endsWith(".woff2"))).toEqual([
        expect.stringMatching(
          new RegExp(`^pinned/${font.sha256}\\.[0-9a-f]{12}\\.vietnamese\\.[0-9a-f]{12}\\.woff2$`),
        ),
        expect.stringMatching(
          new RegExp(`^pinned/${font.sha256}\\.[0-9a-f]{12}\\.latin\\.[0-9a-f]{12}\\.woff2$`),
        ),
      ]);
      expect(preview.preloads).toEqual([]);
      const build = await resolveThemeFonts({
        tokens,
        cacheDir,
        publicBasePath: "/_assets/fonts",
        readFont: fontReader(tx),
        loadFontUsage: () => loadSiteFontUsage(tx, tokens),
        preloadLanguage: null,
      });
      expect(build.files).toEqual(preview.files);
      expect(build.css).toBe(preview.css.replaceAll("/_caelo/fonts", "/_assets/fonts"));
      const restored = await resolveThemeFonts({
        tokens,
        cacheDir,
        publicBasePath: "/restored",
        readFont: fontReader(tx),
        loadFontUsage: () => loadSiteFontUsage(tx, tokens),
        preloadLanguage: null,
      });
      expect(restored.files).toEqual(preview.files);
      const changed = await tx.execute(
        sql`UPDATE font_assets SET sha256=sha256 WHERE id=${font.id}::uuid RETURNING id`,
      );
      expect(changed.length).toBe(0);
      const snapshots = await tx.execute(
        sql`SELECT id FROM theme_snapshots WHERE state::text LIKE ${`%${font.id}%`}`,
      );
      expect(snapshots.length).toBeGreaterThan(0);
      await tx.execute(sql`UPDATE themes SET is_active=false WHERE is_active=true`);
      await tx.execute(sql`UPDATE themes SET is_active=true WHERE slug=${THEME_SLUG}`);
      const published = await generateSite({
        publishAt: new Date().toISOString(),
        tx,
        adapter,
        plugins: localBuildPluginServices,
        runId: crypto.randomUUID(),
        repoRoot: cacheDir,
        target: {
          id: crypto.randomUUID(),
          name: "font-test",
          env: "dev",
          outDir: "site",
          baseUrl: "https://font-test.invalid",
          robotsDefault: "noindex",
        },
      });
      // The registry file (WOFF here, TTF for acquired Google faces) is never
      // published: visitors get derived WOFF2 slices only.
      const publishedFiles = (
        await readdir(join(published.buildDir, "_assets/fonts/pinned"))
      ).sort();
      const expected = build.files.map((f) => f.relPath.slice("pinned/".length));
      expect(publishedFiles).toEqual(expected.sort());
      expect(publishedFiles.filter((f) => !f.endsWith(".woff2"))).toEqual([
        `${font.id}.license.txt`,
      ]);
      for (const f of publishedFiles.filter((name) => name.endsWith(".woff2"))) {
        const bytes = await readFile(join(published.buildDir, "_assets/fonts/pinned", f));
        expect(bytes.subarray(0, 4).toString("ascii")).toBe("wOF2");
        expect(bytes.toString("base64")).not.toBe(data);
      }
      const home = await readFile(join(published.buildDir, "index.html"), "utf8");
      expect(home).not.toMatch(/format\(["']?(truetype|opentype|woff)["']?\)/);
      expect(home).toContain("unicode-range:U+0000-00FF");
      // Site language "en" → only the Latin slice is preloaded.
      const preloads = [...home.matchAll(/<link rel="preload" as="font"[^>]*href="([^"]+)"/g)].map(
        (m) => m[1],
      );
      expect(preloads).toEqual([
        expect.stringMatching(/\/pinned\/[0-9a-f]{64}\.[0-9a-f]{12}\.latin\.[0-9a-f]{12}\.woff2$/),
      ]);
      expect(
        await readFile(
          join(published.buildDir, "_assets/fonts/pinned", `${font.id}.license.txt`),
          "utf8",
        ),
      ).toBe(license.text);
      // Keep other feature fixtures on the seeded active theme.
      await tx.execute(sql`UPDATE themes SET is_active=false WHERE is_active=true`);
      await tx.execute(sql`UPDATE themes SET is_active=true WHERE slug='site-default'`);
    });
    // #1065 — the composed preview (what inspect_page_render reports as the
    // page's HTML) carries the same Latin preload as the build.
    await adapter.withAdminTransaction(ctx, async (tx) => {
      await tx.execute(sql`UPDATE themes SET is_active=false WHERE is_active=true`);
      await tx.execute(sql`UPDATE themes SET is_active=true WHERE slug=${THEME_SLUG}`);
    });
    const composed = (await run("pages.render_preview", { pageId: built.pageId })) as {
      html: string;
    };
    const previewPreloads = [
      ...composed.html.matchAll(/<link rel="preload" as="font"[^>]*href="([^"]+)"/g),
    ].map((m) => m[1]);
    expect(previewPreloads).toEqual([
      expect.stringMatching(
        /^\/_caelo\/fonts\/pinned\/[0-9a-f]{64}\.[0-9a-f]{12}\.latin\.[0-9a-f]{12}\.woff2$/,
      ),
    ]);
  } finally {
    await adapter.withAdminTransaction(ctx, async (tx) => {
      await tx.execute(sql`UPDATE themes SET is_active=false WHERE is_active=true`);
      await tx.execute(sql`UPDATE themes SET is_active=true WHERE slug='site-default'`);
    });
    await rm(cacheDir, { recursive: true, force: true });
  }
});
