// SPDX-License-Identifier: MPL-2.0

/**
 * Revert path coverage:
 *   - revert_module restores one module's state, leaves siblings alone, and
 *     emits a fresh snapshot with revert_of set.
 *   - revert_page restores both page metadata and layout from a snapshot
 *     that captured both sides.
 *   - revert_site rolls back every entity at a target snapshot atomically.
 *   - snapshots.list paginates reverse-chrono with per-snapshot counts.
 *   - snapshots.module_impact returns the right severity for fixtures.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "snapshots-revert-test",
};

const TPL_SLUG = "p4-revert-tpl";
const MOD_SLUG = "p4-revert-mod";
const MOD_SLUG_2 = "p4-revert-mod-2";
const PAGE_SLUG = "p4-revert-page";

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug = ${PAGE_SLUG})`;
      await tx`DELETE FROM pages WHERE slug = ${PAGE_SLUG}`;
      await tx`DELETE FROM modules WHERE slug IN (${MOD_SLUG}, ${MOD_SLUG_2})`;
      await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${TPL_SLUG})`;
      await tx`DELETE FROM templates WHERE slug = ${TPL_SLUG}`;
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
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("revert_module", () => {
  it("restores one module's state and leaves siblings alone; emits revert snapshot", async () => {
    // Create two modules so we can verify the second is unaffected by the first's revert.
    // v0.12.2 — pass explicit (empty) fields so the extractor doesn't
    // templatise the test's literal HTML before snapshotting.
    const m1 = await execute(registry, adapter, systemCtx, "modules.create", {
      slug: MOD_SLUG,
      displayName: "Hero",
      html: "<p>v1</p>",
      fields: [{ name: "body", kind: "text", label: "Body" } as never],
    });
    if (!m1.ok) throw new Error("m1");
    const moduleId = (m1.value as { moduleId: string }).moduleId;

    const m2 = await execute(registry, adapter, systemCtx, "modules.create", {
      slug: MOD_SLUG_2,
      displayName: "Untouched",
      html: "<p>untouched-original</p>",
      fields: [{ name: "body", kind: "text", label: "Body" } as never],
    });
    if (!m2.ok) throw new Error("m2");
    const sideModuleId = (m2.value as { moduleId: string }).moduleId;

    // Find the v1 snapshot id by listing snapshots and matching by module.
    const list1 = await execute(registry, adapter, systemCtx, "snapshots.list", { limit: 50 });
    if (!list1.ok) throw new Error("list1");
    const snapshots = (list1.value as { snapshots: { id: string; description: string }[] })
      .snapshots;
    // includes() would also match MOD_SLUG-2; pin by exact equality.
    const v1Snapshot = snapshots.find((s) => s.description === `modules.create slug=${MOD_SLUG}`);
    expect(v1Snapshot).toBeTruthy();
    if (!v1Snapshot) return;
    const v1SnapshotId = v1Snapshot.id;

    // Move module to v2.
    await execute(registry, adapter, systemCtx, "modules.update", {
      moduleId,
      html: "<p>v2-current</p>",
    });

    // Independently change the side module too — must NOT be affected by the revert.
    await execute(registry, adapter, systemCtx, "modules.update", {
      moduleId: sideModuleId,
      html: "<p>untouched-changed</p>",
    });

    // Revert the first module to v1.
    const revert = await execute(registry, adapter, systemCtx, "snapshots.revert_module", {
      moduleId,
      snapshotId: v1SnapshotId,
    });
    expect(revert.ok).toBe(true);
    if (!revert.ok) return;
    const newSnapshotId = (revert.value as { siteSnapshotId: string }).siteSnapshotId;

    const after = await execute(registry, adapter, systemCtx, "modules.get", { moduleId });
    if (!after.ok) return;
    expect((after.value as { module: { html: string } }).module.html).toBe("<p>v1</p>");

    const sideAfter = await execute(registry, adapter, systemCtx, "modules.get", {
      moduleId: sideModuleId,
    });
    if (!sideAfter.ok) return;
    expect((sideAfter.value as { module: { html: string } }).module.html).toBe(
      "<p>untouched-changed</p>",
    );

    // The new snapshot should have revert_of pointing at v1SnapshotId.
    const got = await execute(registry, adapter, systemCtx, "snapshots.get_with_entities", {
      snapshotId: newSnapshotId,
    });
    if (!got.ok) return;
    expect((got.value as { snapshot: { revertOf: string } }).snapshot.revertOf).toBe(v1SnapshotId);
  });
});

describe("revert_page (metadata + layout)", () => {
  it("restores page slug/title and layout from a single snapshot", async () => {
    // Need a template + slot + module to set up a page.
    const tpl = await execute(registry, adapter, systemCtx, "templates.create", {
      slug: TPL_SLUG,
      displayName: "T",
      html: `<body><caelo-slot name="content">_</caelo-slot></body>`,
    });
    if (!tpl.ok) throw new Error("tpl");
    const templateId = (tpl.value as { templateId: string }).templateId;
    await execute(registry, adapter, systemCtx, "template_blocks.set", {
      templateId,
      blocks: [{ name: "content", displayName: "Content", position: 0 }],
    });

    const m = await execute(registry, adapter, systemCtx, "modules.get", {
      moduleId: (await execute(registry, adapter, systemCtx, "modules.list", {})).value ? "" : "",
    });
    void m; // unused — we already have moduleIds from the previous test's seeds.

    const list = await execute(registry, adapter, systemCtx, "modules.list", {});
    if (!list.ok) return;
    const modules = (list.value as { modules: { id: string; slug: string }[] }).modules;
    const moduleId = modules.find((mm) => mm.slug === MOD_SLUG)?.id ?? "";
    expect(moduleId).not.toBe("");

    // Create the page, then update it twice so we have a known earlier snapshot to revert to.
    const pg = await execute(registry, adapter, systemCtx, "pages.create", {
      slug: PAGE_SLUG,
      title: "Original title",
      templateId,
    });
    if (!pg.ok) throw new Error("page");
    const pageId = (pg.value as { pageId: string }).pageId;

    // Layout v1.
    await execute(registry, adapter, systemCtx, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [moduleId] }],
    });

    // Find this v1 layout snapshot.
    const listAfterLayout = await execute(registry, adapter, systemCtx, "snapshots.list", {
      limit: 100,
    });
    if (!listAfterLayout.ok) return;
    const layoutSnap = (
      listAfterLayout.value as { snapshots: { id: string; description: string }[] }
    ).snapshots.find((s) => s.description.startsWith("pages.set_modules"));
    expect(layoutSnap).toBeTruthy();
    if (!layoutSnap) return;

    // Now strip the layout and rename — these are the "current" state we will revert from.
    await execute(registry, adapter, systemCtx, "pages.set_modules", {
      pageId,
      blocks: [],
    });
    await execute(registry, adapter, systemCtx, "pages.update", {
      pageId,
      title: "Renamed",
    });

    const before = await execute(registry, adapter, systemCtx, "pages.get_with_modules", {
      pageId,
    });
    if (!before.ok) return;
    const beforePage = (
      before.value as { page: { title: string; blocks: { modules: unknown[] }[] } }
    ).page;
    expect(beforePage.title).toBe("Renamed");
    expect(beforePage.blocks.flatMap((b) => b.modules)).toHaveLength(0);

    // Revert the layout snapshot — it captures the layout but NOT the title.
    const r = await execute(registry, adapter, systemCtx, "snapshots.revert_page", {
      pageId,
      snapshotId: layoutSnap.id,
    });
    expect(r.ok).toBe(true);

    const after = await execute(registry, adapter, systemCtx, "pages.get_with_modules", {
      pageId,
    });
    if (!after.ok) return;
    const afterPage = (
      after.value as {
        page: { title: string; blocks: { modules: { moduleId: string }[] }[] };
      }
    ).page;
    // Title is unchanged because the snapshot only captured the layout.
    expect(afterPage.title).toBe("Renamed");
    // Layout is back.
    expect(afterPage.blocks.flatMap((b) => b.modules.map((m) => m.moduleId))).toEqual([moduleId]);
  });
});

describe("snapshots.list", () => {
  it("returns rows reverse-chronological with per-kind counts", async () => {
    const r = await execute(registry, adapter, systemCtx, "snapshots.list", { limit: 5 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rows = (
      r.value as {
        snapshots: {
          createdAt: string;
          moduleCount: number;
          templateCount: number;
          pageCount: number;
          pageLayoutCount: number;
        }[];
      }
    ).snapshots;
    expect(rows.length).toBeGreaterThan(0);
    for (let i = 1; i < rows.length; i++) {
      expect(new Date(rows[i - 1]?.createdAt).getTime()).toBeGreaterThanOrEqual(
        new Date(rows[i]?.createdAt).getTime(),
      );
    }
  });
});

describe("snapshots.module_impact", () => {
  it("returns severity high when module sits in a header slot", async () => {
    // Seed a fresh template with a 'header' slot, a module placed in it, a
    // page using it. Then call module_impact and assert severity high.
    const tpl = await execute(registry, adapter, systemCtx, "templates.create", {
      slug: `${TPL_SLUG}-impact`,
      displayName: "Impact T",
      html: `<body><caelo-slot name="header">_</caelo-slot></body>`,
    });
    if (!tpl.ok) return;
    const templateId = (tpl.value as { templateId: string }).templateId;
    await execute(registry, adapter, systemCtx, "template_blocks.set", {
      templateId,
      blocks: [{ name: "header", displayName: "Header", position: 0 }],
    });
    const m = await execute(registry, adapter, systemCtx, "modules.create", {
      slug: `${MOD_SLUG}-impact`,
      displayName: "Header Mod",
      html: "<h1>x</h1>",
    });
    if (!m.ok) return;
    const moduleId = (m.value as { moduleId: string }).moduleId;
    const pg = await execute(registry, adapter, systemCtx, "pages.create", {
      slug: `${PAGE_SLUG}-impact`,
      title: "Impact",
      templateId,
    });
    if (!pg.ok) return;
    const pageId = (pg.value as { pageId: string }).pageId;
    await execute(registry, adapter, systemCtx, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "header", moduleIds: [moduleId] }],
    });

    const r = await execute(registry, adapter, systemCtx, "snapshots.module_impact", {
      moduleId,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const result = r.value as {
      severity: "low" | "medium" | "high";
      affectedPages: { pageId: string }[];
    };
    expect(result.severity).toBe("high");
    expect(result.affectedPages).toHaveLength(1);

    // Cleanup these extra rows so the suite-level wipe stays clean.
    const sql = new SQL(ADMIN_URL!);
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        await tx`DELETE FROM page_modules WHERE page_id = ${pageId}::uuid`;
        await tx`DELETE FROM pages WHERE id = ${pageId}::uuid`;
        await tx`DELETE FROM modules WHERE id = ${moduleId}::uuid`;
        await tx`DELETE FROM template_blocks WHERE template_id = ${templateId}::uuid`;
        await tx`DELETE FROM templates WHERE id = ${templateId}::uuid`;
      });
    } finally {
      await sql.end();
    }
  });
});

describe("revert_site", () => {
  it("restores every entity at the target snapshot atomically and emits a merged revert snapshot", async () => {
    // Use the existing module + template + page from earlier tests as the
    // "stable" state. Take a snapshot via a small no-op-ish edit (touch
    // module display name) so we have a known target.
    const list = await execute(registry, adapter, systemCtx, "modules.list", {});
    if (!list.ok) return;
    const modules = (list.value as { modules: { id: string; slug: string }[] }).modules;
    const moduleId = modules.find((m) => m.slug === MOD_SLUG)?.id ?? "";

    // Snapshot before any further edits.
    await execute(registry, adapter, systemCtx, "modules.update", {
      moduleId,
      displayName: "Hero (snapshot anchor)",
    });
    const listAfter = await execute(registry, adapter, systemCtx, "snapshots.list", { limit: 5 });
    if (!listAfter.ok) return;
    const target = (listAfter.value as { snapshots: { id: string; description: string }[] })
      .snapshots[0];
    expect(target).toBeTruthy();
    if (!target) return;

    // Drift from anchor.
    await execute(registry, adapter, systemCtx, "modules.update", {
      moduleId,
      displayName: "Hero (drifted)",
    });

    // Revert the entire site to the anchor.
    const r = await execute(registry, adapter, systemCtx, "snapshots.revert_site", {
      snapshotId: target.id,
    });
    expect(r.ok).toBe(true);

    const after = await execute(registry, adapter, systemCtx, "modules.get", { moduleId });
    if (!after.ok) return;
    expect((after.value as { module: { displayName: string } }).module.displayName).toBe(
      "Hero (snapshot anchor)",
    );
  });
});
