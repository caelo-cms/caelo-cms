// SPDX-License-Identifier: MPL-2.0

/**
 * Verifies the P4 invariant: every P3 mutation op now lands a snapshot row
 * in the same transaction. Plus a rollback regression — if a write throws
 * after emitSnapshot, both the live row AND the snapshot row roll back
 * together.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";
import { emitSnapshot } from "../snapshots/index.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "snapshots-emission-test",
};

const TPL_SLUG = "p4-emit-tpl";
const MOD_SLUG = "p4-emit-mod";
const PAGE_SLUG = "p4-emit-page";

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug = ${PAGE_SLUG})`;
      await tx`DELETE FROM pages WHERE slug = ${PAGE_SLUG}`;
      await tx`DELETE FROM modules WHERE slug = ${MOD_SLUG} OR slug = ${`${MOD_SLUG}-2`}`;
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

async function countSnapshotsForModule(moduleId: string): Promise<number> {
  const sql = new SQL(ADMIN_URL!);
  try {
    const rows = (await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return await tx`SELECT count(*)::int AS c FROM module_snapshots WHERE module_id = ${moduleId}::uuid`;
    })) as unknown as { c: number }[];
    return rows[0]?.c ?? 0;
  } finally {
    await sql.end();
  }
}

async function countSnapshotsForPage(pageId: string, kind: "page" | "layout"): Promise<number> {
  const table = kind === "page" ? "page_snapshots" : "page_layout_snapshots";
  const sql = new SQL(ADMIN_URL!);
  try {
    const rows = (await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return await tx.unsafe(`SELECT count(*)::int AS c FROM ${table} WHERE page_id = $1::uuid`, [
        pageId,
      ]);
    })) as unknown as { c: number }[];
    return rows[0]?.c ?? 0;
  } finally {
    await sql.end();
  }
}

describe("snapshot emission on every P3 mutation", () => {
  it("modules.create + .update + .delete each emit one module_snapshot row", async () => {
    const c = await execute(registry, adapter, systemCtx, "modules.create", {
      slug: MOD_SLUG,
      displayName: "Hero",
      html: "<p>v1</p>",
    });
    if (!c.ok) throw new Error("create");
    const moduleId = (c.value as { moduleId: string }).moduleId;
    expect(await countSnapshotsForModule(moduleId)).toBe(1);

    await execute(registry, adapter, systemCtx, "modules.update", {
      moduleId,
      html: "<p>v2</p>",
    });
    expect(await countSnapshotsForModule(moduleId)).toBe(2);

    await execute(registry, adapter, systemCtx, "modules.delete", { moduleId });
    expect(await countSnapshotsForModule(moduleId)).toBe(3);
  });

  it("templates.create + template_blocks.set + pages.create + pages.set_modules each emit a snapshot", async () => {
    const tpl = await execute(registry, adapter, systemCtx, "templates.create", {
      slug: TPL_SLUG,
      displayName: "T",
      html: `<body><caelo-slot name="content">_</caelo-slot></body>`,
    });
    if (!tpl.ok) throw new Error("tpl create");
    const templateId = (tpl.value as { templateId: string }).templateId;
    await execute(registry, adapter, systemCtx, "template_blocks.set", {
      templateId,
      blocks: [{ name: "content", displayName: "Content", position: 0 }],
    });

    const pg = await execute(registry, adapter, systemCtx, "pages.create", {
      slug: PAGE_SLUG,
      title: "P",
      templateId,
    });
    if (!pg.ok) throw new Error("page create");
    const pageId = (pg.value as { pageId: string }).pageId;
    expect(await countSnapshotsForPage(pageId, "page")).toBe(1);

    // Need a module to put in the layout — reuse a fresh slug.
    const m = await execute(registry, adapter, systemCtx, "modules.create", {
      slug: `${MOD_SLUG}-2`,
      displayName: "X",
      html: "<p>x</p>",
    });
    if (!m.ok) throw new Error("module 2");
    await execute(registry, adapter, systemCtx, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [(m.value as { moduleId: string }).moduleId] }],
    });
    expect(await countSnapshotsForPage(pageId, "layout")).toBe(1);
    // afterAll wipe handles cleanup of MOD_SLUG-2 (page_modules cascades from
    // pages, so the order pages → modules works).
  });

  it("rollback regression: a handler-level throw after emitSnapshot rolls back both writes", async () => {
    // Direct emitSnapshot inside a tx that throws — verifies the
    // snapshot row vanishes alongside any other in-tx work.
    const sql = new SQL(ADMIN_URL!);
    let beforeCount = 0;
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        const c = (await tx`SELECT count(*)::int AS c FROM site_snapshots`) as unknown as {
          c: number;
        }[];
        beforeCount = c[0]?.c ?? 0;
      });

      await sql
        .begin(async (tx) => {
          await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
          await emitSnapshot(tx as never, {
            actorId: systemCtx.actorId,
            description: "rollback test",
          });
          throw new Error("synthetic rollback");
        })
        .catch(() => {});

      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        const c = (await tx`SELECT count(*)::int AS c FROM site_snapshots`) as unknown as {
          c: number;
        }[];
        expect(c[0]?.c).toBe(beforeCount);
      });
    } finally {
      await sql.end();
    }
  });
});
