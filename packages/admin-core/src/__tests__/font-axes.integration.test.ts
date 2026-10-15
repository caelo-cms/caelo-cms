// SPDX-License-Identifier: MPL-2.0

/**
 * Per-face variation-axis policy end to end against a real Postgres:
 * the site-wide usage scan reads stored modules, the override is written
 * face-wide by themes.update_tokens (and validated against the face's real
 * axes), themes.font_delivery reports what the resolver does, and preview
 * and build — the same resolver fed by the same loader — instance the
 * face identically.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fontMetadata, fontReader, openFont } from "@caelo-cms/font-service";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext, ThemeDocument } from "@caelo-cms/shared";
import { loadSiteFontUsage, resolveThemeFonts } from "@caelo-cms/static-generator";
import { sql } from "drizzle-orm";
import { registerAdminOps } from "../register.js";

const adapter = new DatabaseAdapter({
  adminDatabaseUrl: process.env.ADMIN_DATABASE_URL!,
  publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL!,
});
const registry = new OperationRegistry();
registerAdminOps(registry);
const ctx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "font-axes-test",
};
const AI: ExecutionContext = { ...ctx, actorKind: "ai", requestId: "font-axes-test-ai" };
const THEME_SLUG = `font-axes-${crypto.randomUUID().slice(0, 8)}`;
const MODULE_SLUG = `${THEME_SLUG}-light`;
const FIXTURES = new URL("../../../font-service/src/fixtures/", import.meta.url);
const interBase64 = readFileSync(
  new URL("InterVariable-mini.woff2.base64.txt", FIXTURES),
  "utf8",
).trim();
const license = {
  name: "OFL-1.1",
  text: readFileSync(new URL("Inter-OFL.txt", FIXTURES), "utf8"),
  webEmbedding: true,
  documentEmbedding: true,
};

async function run(name: string, input: unknown, identity: ExecutionContext = ctx) {
  const result = await execute(registry, adapter, identity, name, input);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

interface Delivery {
  weightUsage: { weights: number[] | null; uncertain: string[] };
  faces: {
    roles: { role: string }[];
    override: unknown;
    effective: Record<string, unknown>;
    origin: Record<string, string>;
    fontWeightDescriptor: string;
    delivered: { totalBytes: number } | null;
  }[];
}

let cacheDir: string;
beforeAll(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "font-axes-test-"));
});
afterAll(async () => {
  await adapter.withAdminTransaction(ctx, async (tx) => {
    await tx.execute(
      sql`DELETE FROM theme_snapshots WHERE theme_id IN (SELECT id FROM themes WHERE slug=${THEME_SLUG})`,
    );
    await tx.execute(sql`DELETE FROM themes WHERE slug=${THEME_SLUG}`);
    await tx.execute(sql`DELETE FROM modules WHERE slug=${MODULE_SLUG}`);
  });
  await adapter.close();
  await rm(cacheDir, { recursive: true, force: true });
});

test("axis policy: usage scan, face-wide override, read surface and preview/build parity", async () => {
  const font = fontMetadata.parse(
    await run("fonts.import", { dataBase64: interBase64, license, source: "test:inter-mini" }),
  );
  const ref = { id: font.id, sha256: font.sha256 };
  expect(Object.keys(font.axes).sort()).toEqual(["opsz", "wght"]);
  await run("themes.duplicate", {
    sourceSlug: "site-default",
    newSlug: THEME_SLUG,
    newDisplayName: "Font axes test",
  });
  await run("themes.update_tokens", { themeSlug: THEME_SLUG, fontBindings: { body: ref } });

  // A stored module using weight 250 widens the derived default below 400.
  await run("modules.create", {
    slug: MODULE_SLUG,
    displayName: "Light caption",
    html: '<p class="cap">x</p>',
    css: ".cap{font-weight:250}",
  });
  const tokensOf = async () =>
    ((await run("themes.get", { slug: THEME_SLUG })) as { theme: { tokens: ThemeDocument } }).theme
      .tokens;
  await adapter.withAdminTransaction(ctx, async (tx) => {
    const usage = await loadSiteFontUsage(tx, await tokensOf());
    // Other fixtures may make the shared test DB's usage uncertain; when it
    // is certain it must contain the module's weight.
    if (usage.weights !== null) expect(usage.weights).toContain(250);
  });

  const before = (await run("themes.font_delivery", { themeSlug: THEME_SLUG }, AI)) as Delivery;
  expect(before.faces).toHaveLength(1);
  expect(before.faces[0]?.override).toBeNull();
  expect(before.faces[0]?.effective.opsz).toEqual({ mode: "pin", value: 14 });
  expect(before.faces[0]?.origin).toEqual({ opsz: "default", wght: "default" });
  if (before.weightUsage.weights !== null) {
    expect(before.faces[0]?.fontWeightDescriptor).toBe("250 900");
  }
  expect(before.faces[0]?.delivered).toBeNull(); // nothing rendered yet

  // Binding a second role to the same face, then overriding via one role,
  // writes the override on every role of the face.
  await run("themes.update_tokens", { themeSlug: THEME_SLUG, fontBindings: { heading: ref } });
  await run(
    "themes.update_tokens",
    {
      themeSlug: THEME_SLUG,
      fontAxes: { heading: { opsz: "full", wght: { min: 200, max: 800 } } },
    },
    AI,
  );
  const tokens = await tokensOf();
  const typography = tokens.typography as Record<string, { $extensions?: Record<string, unknown> }>;
  for (const role of ["body", "heading"]) {
    expect(typography[role]?.$extensions?.["caelo.fontAxes"]).toEqual({
      opsz: "full",
      wght: { min: 200, max: 800 },
    });
  }

  // A range that excludes a weight a bound role uses is refused at write time.
  const excludes = await execute(registry, adapter, AI, "themes.update_tokens", {
    themeSlug: THEME_SLUG,
    fontAxes: { body: { wght: { min: 500, max: 800 } } },
  });
  expect(JSON.stringify(excludes)).toContain("uses weight 400, outside the wght range 500-800");

  // Values outside the face's range / unknown axes are rejected with the real ranges.
  const outside = await execute(registry, adapter, AI, "themes.update_tokens", {
    themeSlug: THEME_SLUG,
    fontAxes: { body: { wght: { min: 50, max: 800 } } },
  });
  expect(outside.ok).toBe(false);
  expect(JSON.stringify(outside)).toContain("outside the face's wght range 100-900");
  const unknown = await execute(registry, adapter, AI, "themes.update_tokens", {
    themeSlug: THEME_SLUG,
    fontAxes: { body: { wdth: 100 } },
  });
  expect(JSON.stringify(unknown)).toContain("no 'wdth' axis");

  // Preview and build: same resolver, same loader → identical instancing.
  await adapter.withAdminTransaction(ctx, async (tx) => {
    const common = {
      tokens,
      cacheDir,
      readFont: fontReader(tx, ctx),
      loadFontUsage: () => loadSiteFontUsage(tx, tokens),
      preloadLanguage: null,
    };
    const preview = await resolveThemeFonts({ ...common, publicBasePath: "/_caelo/fonts" });
    const build = await resolveThemeFonts({ ...common, publicBasePath: "/_assets/fonts" });
    expect(preview.unresolved).toEqual([]);
    expect(build.files).toEqual(preview.files);
    expect(build.css).toBe(preview.css.replaceAll("/_caelo/fonts", "/_assets/fonts"));
    expect(preview.css).toContain("font-weight:200 800");
    const latin = preview.files.find((f) => /\.latin\./.test(f.relPath));
    const axes = (
      openFont(await readFile(latin!.cachePath)).font as unknown as {
        variationAxes: Record<string, { min: number; max: number }>;
      }
    ).variationAxes;
    expect(axes.opsz).toMatchObject({ min: 14, max: 32 });
    expect(axes.wght).toMatchObject({ min: 200, max: 800 });
  });

  // Reset → back to the default; the read surface reflects it.
  await run("themes.update_tokens", { themeSlug: THEME_SLUG, fontAxes: { body: null } }, AI);
  const after = (await run("themes.font_delivery", { themeSlug: THEME_SLUG }, AI)) as Delivery;
  expect(after.faces[0]?.override).toBeNull();
  expect(after.faces[0]?.roles.map((r) => r.role).sort()).toEqual(["body", "heading"]);
});
