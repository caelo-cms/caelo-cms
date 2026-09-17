// SPDX-License-Identifier: MPL-2.0
import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fontMetadata, fontReader } from "@caelo-cms/font-service";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { applyDtcgWrites, type ExecutionContext, type ThemeDocument } from "@caelo-cms/shared";
import { generateSite, resolveThemeFonts } from "@caelo-cms/static-generator";
import { sql } from "drizzle-orm";
import { registerAdminOps } from "../register.js";

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
afterAll(async () => {
  await adapter.withAdminTransaction(ctx, async (tx) => {
    await tx.execute(
      sql`DELETE FROM theme_snapshots WHERE theme_id IN (SELECT id FROM themes WHERE slug=${THEME_SLUG})`,
    );
    await tx.execute(sql`DELETE FROM themes WHERE slug=${THEME_SLUG}`);
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
  const cacheDir = await mkdtemp(join(tmpdir(), "font-service-test-"));
  try {
    await adapter.withAdminTransaction(ctx, async (tx) => {
      const preview = await resolveThemeFonts({
        tokens,
        cacheDir,
        publicBasePath: "/_caelo/fonts",
        readFont: fontReader(tx, ctx),
        fetcher: (() => {
          throw new Error("Unexpected font network fetch");
        }) as typeof fetch,
      });
      expect(preview.unresolved).toEqual([]);
      expect(preview.css).toContain(font.cssFamily);
      expect(preview.files.length).toBe(2);
      expect(Buffer.from(await readFile(preview.files[0]!.cachePath)).toString("base64")).toBe(
        data,
      );
      const build = await resolveThemeFonts({
        tokens,
        cacheDir,
        publicBasePath: "/_assets/fonts",
        readFont: fontReader(tx, ctx),
      });
      expect(build.files).toEqual(preview.files);
      expect(build.css).toBe(preview.css.replaceAll("/_caelo/fonts", "/_assets/fonts"));
      const restored = await resolveThemeFonts({
        tokens,
        cacheDir,
        publicBasePath: "/restored",
        readFont: fontReader(tx, ctx),
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
        tx,
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
      const publishedFiles = await readdir(join(published.buildDir, "_assets/fonts/pinned"));
      expect(publishedFiles.sort()).toEqual(
        [`${font.id}.license.txt`, `${font.sha256}.woff`].sort(),
      );
      expect(
        Buffer.from(
          await readFile(join(published.buildDir, "_assets/fonts/pinned", `${font.sha256}.woff`)),
        ).toString("base64"),
      ).toBe(data);
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
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});
