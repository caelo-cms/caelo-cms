// SPDX-License-Identifier: MPL-2.0

/**
 * Templates + template_blocks integration. Verifies:
 *   - templates CRUD round-trip with soft delete
 *   - `template_blocks.set` is atomic (replace, not merge)
 *   - duplicate block names within one payload are rejected
 *   - `templates.delete` blocks while a non-deleted page references it
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
  requestId: "content-templates-test",
};

const TEMPLATE_SLUGS = ["p3-tpl-main", "p3-tpl-blog", "p3-tpl-locked"] as const;
const PAGE_SLUGS = ["p3-tpl-locked-page"] as const;

async function wipe(url: string): Promise<void> {
  const sql = new SQL(url);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      for (const slug of PAGE_SLUGS) {
        await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug = ${slug})`;
        await tx`DELETE FROM pages WHERE slug = ${slug}`;
      }
      for (const slug of TEMPLATE_SLUGS) {
        await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${slug})`;
        await tx`DELETE FROM templates WHERE slug = ${slug}`;
      }
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  await wipe(ADMIN_URL);
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

afterAll(async () => {
  await wipe(ADMIN_URL);
  await adapter.close();
});

describe("templates CRUD", () => {
  it("creates, lists with blocks, and deletes a template", async () => {
    const create = await execute(registry, adapter, systemCtx, "templates.create", {
      slug: TEMPLATE_SLUGS[0],
      displayName: "Main",
      html: `<html><body><caelo-slot name="content">x</caelo-slot></body></html>`,
    });
    expect(create.ok).toBe(true);
    if (!create.ok) return;
    const templateId = (create.value as { templateId: string }).templateId;

    const setBlocks = await execute(registry, adapter, systemCtx, "template_blocks.set", {
      templateId,
      blocks: [{ name: "content", displayName: "Content", position: 0 }],
    });
    expect(setBlocks.ok).toBe(true);

    const list = await execute(registry, adapter, systemCtx, "templates.list", {});
    if (!list.ok) return;
    const found = (
      list.value as { templates: { slug: string; blocks: { name: string }[] }[] }
    ).templates.find((t) => t.slug === TEMPLATE_SLUGS[0]);
    expect(found?.blocks.map((b) => b.name)).toEqual(["content"]);

    const del = await execute(registry, adapter, systemCtx, "templates.delete", { templateId });
    expect(del.ok).toBe(true);
  });

  it("template_blocks.set is atomic — replaces all rows in one shot", async () => {
    const create = await execute(registry, adapter, systemCtx, "templates.create", {
      slug: TEMPLATE_SLUGS[1],
      displayName: "Blog",
      html: `<body><caelo-slot name="content">_</caelo-slot></body>`,
    });
    if (!create.ok) return;
    const templateId = (create.value as { templateId: string }).templateId;

    await execute(registry, adapter, systemCtx, "template_blocks.set", {
      templateId,
      blocks: [
        { name: "header", displayName: "Header", position: 0 },
        { name: "content", displayName: "Content", position: 1 },
      ],
    });
    await execute(registry, adapter, systemCtx, "template_blocks.set", {
      templateId,
      blocks: [{ name: "content", displayName: "Content", position: 0 }],
    });
    const got = await execute(registry, adapter, systemCtx, "templates.get", { templateId });
    if (!got.ok) return;
    const blocks = (got.value as { template: { blocks: { name: string }[] } }).template.blocks;
    expect(blocks.map((b) => b.name)).toEqual(["content"]);
  });

  it("rejects duplicate block names within one payload", async () => {
    const create = await execute(registry, adapter, systemCtx, "templates.create", {
      slug: TEMPLATE_SLUGS[2],
      displayName: "Locked",
      html: `<body><caelo-slot name="x">_</caelo-slot></body>`,
    });
    if (!create.ok) return;
    const templateId = (create.value as { templateId: string }).templateId;

    const r = await execute(registry, adapter, systemCtx, "template_blocks.set", {
      templateId,
      blocks: [
        { name: "x", displayName: "X1", position: 0 },
        { name: "x", displayName: "X2", position: 1 },
      ],
    });
    expect(r.ok).toBe(false);
  });

  it("templates.delete blocks while a non-deleted page references the template", async () => {
    // Reuse the locked template.
    const list = await execute(registry, adapter, systemCtx, "templates.list", {});
    if (!list.ok) return;
    const tpl = (list.value as { templates: { id: string; slug: string }[] }).templates.find(
      (t) => t.slug === TEMPLATE_SLUGS[2],
    );
    expect(tpl).toBeTruthy();
    if (!tpl) return;

    await execute(registry, adapter, systemCtx, "template_blocks.set", {
      templateId: tpl.id,
      blocks: [{ name: "content", displayName: "Content", position: 0 }],
    });
    const pg = await execute(registry, adapter, systemCtx, "pages.create", {
      slug: PAGE_SLUGS[0],
      title: "Locked Page",
      templateId: tpl.id,
    });
    expect(pg.ok).toBe(true);

    const del = await execute(registry, adapter, systemCtx, "templates.delete", {
      templateId: tpl.id,
    });
    expect(del.ok).toBe(false);
  });
});
