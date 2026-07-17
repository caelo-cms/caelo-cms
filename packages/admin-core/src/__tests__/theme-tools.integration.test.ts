// SPDX-License-Identifier: MPL-2.0

/**
 * Coverage for the theme + genesis read/config tools that had no dedicated
 * test (the thickest gap in the catalogue): get_theme, list_themes,
 * duplicate_theme, export_theme, import_theme, set_theme_asset,
 * set_design_manifest, list_genesis_drafts.
 *
 * Exercised against the seeded `site-default` theme (present after migrate).
 * Real Postgres (§6). The gated theme ops (create/activate/delete) have their
 * own propose/execute tests; these are the direct read/config surfaces.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import type { ToolContext } from "../ai/tools/dispatch.js";
import { duplicateThemeTool } from "../ai/tools/duplicate-theme.js";
import { exportThemeTool } from "../ai/tools/export-theme.js";
import { listGenesisDraftsTool } from "../ai/tools/genesis-tools.js";
import { getThemeTool } from "../ai/tools/get-theme.js";
import { importThemeTool } from "../ai/tools/import-theme.js";
import { listThemesTool } from "../ai/tools/list-themes.js";
import { setDesignManifestTool } from "../ai/tools/set-design-manifest.js";
import { setThemeAssetTool } from "../ai/tools/set-theme-asset.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "theme-tools-int",
};
const DUP = "test-theme-dup";
const toolCtx = () => ({ adapter, registry }) as ToolContext;

/** The design manifest is a site-singleton; capture it so afterAll restores it. */
let originalManifest: unknown = null;

async function cleanup(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM theme_snapshots WHERE theme_id IN (SELECT id FROM themes WHERE slug LIKE 'test-theme-%')`;
      await tx`DELETE FROM themes WHERE slug LIKE 'test-theme-%'`;
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await cleanup();
  const m = await execute(registry, adapter, SYSTEM, "design_manifest.get", {});
  if (m.ok) originalManifest = (m.value as { manifest: unknown }).manifest;
});

afterAll(async () => {
  await cleanup();
  // Restore the site design manifest so the test doesn't leave state behind.
  if (originalManifest) {
    await execute(registry, adapter, SYSTEM, "design_manifest.set", { manifest: originalManifest });
  }
  await adapter.close();
});

describe("theme read tools", () => {
  it("list_themes returns the seeded site-default", async () => {
    const r = await listThemesTool.handler(SYSTEM, {}, toolCtx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain("site-default");
  });

  it("get_theme fetches a theme by slug", async () => {
    const r = await getThemeTool.handler(SYSTEM, { slug: "site-default", as: "dtcg" }, toolCtx());
    expect(r.ok).toBe(true);
    expect(r.content.length).toBeGreaterThan(0);
  });

  it("get_theme reports a missing theme AND inlines the available slugs (one-step recovery)", async () => {
    const r = await getThemeTool.handler(
      SYSTEM,
      { slug: "no-such-theme-xyz", as: "dtcg" },
      toolCtx(),
    );
    expect(r.ok).toBe(false);
    // Run-B regression: the model guessed 'default'/'active' and needed a
    // list_themes round-trip — the miss now carries the inventory inline.
    expect(r.content).toContain("does not exist");
    expect(r.content).toContain("site-default");
  });

  it("get_theme without slug falls back to the ACTIVE theme", async () => {
    const r = await getThemeTool.handler(SYSTEM, { as: "summary" }, toolCtx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain(", active)");
  });

  it("export_theme emits a DTCG document", async () => {
    const r = await exportThemeTool.handler(SYSTEM, { themeSlug: "site-default" }, toolCtx());
    expect(r.ok).toBe(true);
    expect(r.content.length).toBeGreaterThan(0);
  });

  it("list_genesis_drafts responds (empty state is fine)", async () => {
    const r = await listGenesisDraftsTool.handler(SYSTEM, {}, toolCtx());
    expect(r.ok).toBe(true);
  });
});

describe("theme config tools", () => {
  it("duplicate_theme clones site-default under a new slug", async () => {
    const r = await duplicateThemeTool.handler(
      SYSTEM,
      { sourceSlug: "site-default", newSlug: DUP, newDisplayName: "Test Dup" },
      toolCtx(),
    );
    expect(r.ok).toBe(true);
    // The duplicate is now listable + fetchable.
    const got = await getThemeTool.handler(SYSTEM, { slug: DUP, as: "dtcg" }, toolCtx());
    expect(got.ok).toBe(true);
  });

  it("import_theme applies a DTCG body to an existing theme", async () => {
    // Round-trip: export site-default (returns { themeId, body } where body is
    // the DTCG JSON string), import that body into the duplicate.
    const exp = await execute(registry, adapter, SYSTEM, "themes.export_dtcg", {
      themeSlug: "site-default",
    });
    if (!exp.ok) throw new Error("export for import round-trip");
    const body = (exp.value as { body: string }).body;

    const r = await importThemeTool.handler(SYSTEM, { themeSlug: DUP, body }, toolCtx());
    expect(r.ok).toBe(true);
  });

  it("set_theme_asset clears a slot (mediaId=null) without needing a media row", async () => {
    const r = await setThemeAssetTool.handler(
      SYSTEM,
      { themeSlug: DUP, slot: "logo", mediaId: null },
      toolCtx(),
    );
    expect(r.ok).toBe(true);
  });

  it("set_design_manifest writes the site design language", async () => {
    const r = await setDesignManifestTool.handler(
      SYSTEM,
      {
        manifest: {
          typography: "Display: system-ui bold; body: system-ui regular.",
          rhythm: "8px base spacing scale.",
          patterns: [{ name: "Hero", spec: "Full-bleed heading + one CTA." }],
        },
      },
      toolCtx(),
    );
    expect(r.ok).toBe(true);
    // It reads back through the manifest getter.
    const got = await execute(registry, adapter, SYSTEM, "design_manifest.get", {});
    expect(got.ok).toBe(true);
    if (got.ok) {
      const man = (got.value as { manifest: { typography?: string } | null }).manifest;
      expect(man?.typography).toContain("system-ui");
    }
  });
});
