// SPDX-License-Identifier: MPL-2.0

/**
 * Coverage for the theme + genesis read/config tools that had no dedicated
 * test (the thickest gap in the catalogue): get_theme, list_themes,
 * duplicate_theme, export_theme, import_theme, set_theme_asset,
 * list_design_drafts.
 *
 * Exercised against the seeded `site-default` theme (present after migrate).
 * Real Postgres (§6). The gated theme ops (create/activate/delete) have their
 * own propose/execute tests; these are the direct read/config surfaces.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { listDesignDraftsTool } from "../ai/tools/design-draft-tools.js";
import type { ToolContext } from "../ai/tools/dispatch.js";
import { duplicateThemeTool } from "../ai/tools/duplicate-theme.js";
import { exportThemeTool } from "../ai/tools/export-theme.js";
import { findMediaTool } from "../ai/tools/find-media.js";
import { getThemeTool } from "../ai/tools/get-theme.js";
import { importThemeTool } from "../ai/tools/import-theme.js";
import { listThemesTool } from "../ai/tools/list-themes.js";
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

// Issue #411 bind-from-find_media regression — sha-tagged so cleanup()
// can scrub even after a failed mid-test run.
const MEDIA_SHA = `0411f411${"a".repeat(56)}`;
const MEDIA_NAME = "issue411-bind-regression.png";

async function cleanup(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM theme_snapshots WHERE theme_id IN (SELECT id FROM themes WHERE slug LIKE 'test-theme-%')`;
      await tx`DELETE FROM themes WHERE slug LIKE 'test-theme-%'`;
      await tx`DELETE FROM media_variants WHERE asset_id IN (SELECT id FROM media_assets WHERE sha256 = ${MEDIA_SHA})`;
      await tx`DELETE FROM media_assets WHERE sha256 = ${MEDIA_SHA}`;
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
});

afterAll(async () => {
  await cleanup();
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

  it("list_design_drafts responds (empty state is fine)", async () => {
    const r = await listDesignDraftsTool.handler(SYSTEM, {}, toolCtx());
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

  it("binds a theme slot with the id taken from a find_media row (issue #411)", async () => {
    // The 2026-08-03 dogfood failure: the agent had imported the logo but
    // find_media's TOON table dropped the id, so set_theme_asset could
    // never be satisfied. The id must be readable from the tool's CONTENT
    // string — the raw op value never reaches the model's transcript.
    const up = await execute(registry, adapter, SYSTEM, "media.upload", {
      sha256: MEDIA_SHA,
      originalName: MEDIA_NAME,
      mime: "image/png",
      sizeBytes: 2048,
      width: 512,
      height: 512,
      alt: "issue 411 bind regression",
      storageKey: `${MEDIA_SHA}/orig.png`,
      variants: [
        {
          variant: "orig",
          format: "png",
          width: 512,
          height: 512,
          sizeBytes: 2048,
          storageKey: `${MEDIA_SHA}/orig.png`,
        },
      ],
    });
    expect(up.ok).toBe(true);
    if (!up.ok) return;
    const uploadedId = (up.value as { assetId: string }).assetId;

    const found = await findMediaTool.handler(SYSTEM, { filter: MEDIA_NAME }, toolCtx());
    expect(found.ok).toBe(true);
    // TOON header declares the id column; the row's first cell is the UUID.
    const [header = "", ...rows] = found.content.split("\n");
    expect(header).toContain("{id,");
    const row = rows.find((l) => l.includes(MEDIA_NAME));
    expect(row).toBeDefined();
    const modelVisibleId = (row ?? "").trim().split(",")[0] ?? "";
    expect(modelVisibleId).toBe(uploadedId);

    const bound = await setThemeAssetTool.handler(
      SYSTEM,
      { themeSlug: DUP, slot: "logo", mediaId: modelVisibleId },
      toolCtx(),
    );
    expect(bound.ok).toBe(true);
    expect(bound.content).toContain(modelVisibleId);
  });
});
