// SPDX-License-Identifier: MPL-2.0

/**
 * `set_pages_status_many` is the ONE page-status tool — audit follow-up folded
 * the singular `set_page_status` into it (n=1 is a one-item `pageIds` array).
 * These tests pin both the single-page case (proving the fold works) and the
 * bulk case + the all-or-nothing rollback contract, against real Postgres (§6).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import type { ToolContext } from "../ai/tools/dispatch.js";
import { setPagesStatusManyTool } from "../ai/tools/set-pages-status-many.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "set-status-int",
};

const PFX = "setstatus";
let templateId: string;

async function statusOf(pageId: string): Promise<string | null> {
  const sql = new SQL(ADMIN_URL!);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const rows = (await tx`SELECT status FROM pages WHERE id = ${pageId}::uuid`) as unknown as {
        status: string;
      }[];
      return rows[0]?.status ?? null;
    });
  } finally {
    await sql.end();
  }
}

async function makePage(slug: string): Promise<string> {
  const r = await execute(registry, adapter, SYSTEM, "pages.create", {
    slug,
    title: `T ${slug}`,
    templateId,
  });
  if (!r.ok) throw new Error(`seed ${slug}`);
  return (r.value as { pageId: string }).pageId;
}

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}-%`})`;
      await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}-%`}`;
      await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE ${`${PFX}-%`})`;
      await tx`DELETE FROM templates WHERE slug LIKE ${`${PFX}-%`}`;
    });
  } finally {
    await sql.end();
  }
}

const toolCtx = () => ({ adapter, registry }) as ToolContext;

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  const tpl = await execute(registry, adapter, SYSTEM, "templates.create", {
    slug: `${PFX}-tpl`,
    displayName: "S",
    html: `<!doctype html><html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
    css: "",
  });
  if (!tpl.ok) throw new Error("tpl");
  templateId = (tpl.value as { templateId: string }).templateId;
  await execute(registry, adapter, SYSTEM, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("set_pages_status_many — one tool for 1 or many", () => {
  /** Opposite of the given status — flip target that's guaranteed to change. */
  const other = (s: string | null) => (s === "published" ? "draft" : "published");

  it("flips a SINGLE page (the fold: one-item pageIds array)", async () => {
    const id = await makePage(`${PFX}-single`);
    const before = await statusOf(id);
    const target = other(before) as "draft" | "published";

    const r = await setPagesStatusManyTool.handler(
      SYSTEM,
      { pageIds: [id], status: target },
      toolCtx(),
    );
    expect(r.ok).toBe(true);
    expect(await statusOf(id)).toBe(target);
    expect(await statusOf(id)).not.toBe(before);
  });

  it("flips MANY pages in one call", async () => {
    const a = await makePage(`${PFX}-a`);
    const b = await makePage(`${PFX}-b`);
    const c = await makePage(`${PFX}-c`);
    const target = other(await statusOf(a)) as "draft" | "published";
    const r = await setPagesStatusManyTool.handler(
      SYSTEM,
      { pageIds: [a, b, c], status: target },
      toolCtx(),
    );
    expect(r.ok).toBe(true);
    for (const id of [a, b, c]) expect(await statusOf(id)).toBe(target);
  });

  it("skips ids that don't match a live page; flips the ones that do", async () => {
    const good = await makePage(`${PFX}-good`);
    const before = await statusOf(good);
    const target = other(before) as "draft" | "published";
    const missing = "11111111-1111-4111-8111-111111119999";
    const r = await setPagesStatusManyTool.handler(
      SYSTEM,
      { pageIds: [good, missing], status: target },
      toolCtx(),
    );
    // A missing id is skipped, NOT an error (single WHERE id = ANY() UPDATE).
    expect(r.ok).toBe(true);
    expect(r.content).toContain("1 page"); // updatedCount = 1, not 2
    expect(await statusOf(good)).toBe(target);
  });

  it("fails only when NO id matches a live page", async () => {
    const r = await setPagesStatusManyTool.handler(
      SYSTEM,
      { pageIds: ["11111111-1111-4111-8111-1111111199a1"], status: "published" },
      toolCtx(),
    );
    expect(r.ok).toBe(false);
  });
});
