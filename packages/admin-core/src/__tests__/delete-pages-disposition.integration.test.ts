// SPDX-License-Identifier: MPL-2.0

/**
 * audit #4 — deleting a page carries a dead-URL `disposition`, and BULK delete
 * carries it per page. `delete_page` folded into `delete_pages_many`; the
 * disposition/redirect side-effect moved from the tool into `pages.delete` so
 * `pages.delete_many` (which loops that op) inherits it.
 *
 * The regression this pins: before the fold, `delete_pages_many` took a flat
 * `pageIds` list with NO disposition, so every bulk-deleted page silently 404'd
 * — a dead URL with no 301, every inbound link stranded. The "bulk delete with
 * redirect disposition → 301 created" case is the test that would have caught
 * it.
 *
 * Real Postgres per CLAUDE.md §6.
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

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "del-disp-int",
};

const PFX = "deldisp";
const TPL_SLUG = `${PFX}-tpl`;
let templateId: string;

/** Redirect rows out of `fromPath` (RLS needs caelo.actor_kind). */
async function redirectsFrom(
  fromPath: string,
): Promise<{ to_path: string; status_code: number }[]> {
  const sql = new SQL(ADMIN_URL!);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return (await tx`
        SELECT to_path, status_code FROM redirects WHERE from_path = ${fromPath}
      `) as unknown as { to_path: string; status_code: number }[];
    });
  } finally {
    await sql.end();
  }
}

async function isDeleted(pageId: string): Promise<boolean> {
  const sql = new SQL(ADMIN_URL!);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const rows = (await tx`
        SELECT deleted_at FROM pages WHERE id = ${pageId}::uuid
      `) as unknown as { deleted_at: Date | null }[];
      return rows[0]?.deleted_at != null;
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
  if (!r.ok) throw new Error(`page seed ${slug}`);
  return (r.value as { pageId: string }).pageId;
}

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM redirects WHERE from_path LIKE ${`/${PFX}-%`} OR to_path LIKE ${`/${PFX}-%`}`;
      await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}-%`})`;
      await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}-%`}`;
      await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE ${`${PFX}-%`})`;
      await tx`DELETE FROM templates WHERE slug LIKE ${`${PFX}-%`}`;
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
  const tpl = await execute(registry, adapter, SYSTEM, "templates.create", {
    slug: TPL_SLUG,
    displayName: "Del T",
    html: `<!doctype html><html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
    css: "",
  });
  if (!tpl.ok) throw new Error("tpl seed");
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

describe("pages.delete — dead-URL disposition", () => {
  it("disposition='404' soft-deletes and creates NO redirect", async () => {
    const id = await makePage(`${PFX}-single404`);
    const r = await execute(registry, adapter, SYSTEM, "pages.delete", {
      pageId: id,
      disposition: "404",
    });
    expect(r.ok).toBe(true);
    expect(await isDeleted(id)).toBe(true);
    expect(await redirectsFrom(`/${PFX}-single404`)).toHaveLength(0);
  });

  it("disposition='redirect' creates a 301 from the old path", async () => {
    const id = await makePage(`${PFX}-singleredir`);
    const r = await execute(registry, adapter, SYSTEM, "pages.delete", {
      pageId: id,
      disposition: "redirect",
      redirectTo: "/home",
    });
    expect(r.ok).toBe(true);
    expect(await isDeleted(id)).toBe(true);
    const reds = await redirectsFrom(`/${PFX}-singleredir`);
    expect(reds).toHaveLength(1);
    expect(reds[0]?.to_path).toBe("/home");
    expect(Number(reds[0]?.status_code)).toBe(301);
  });

  it("omitting disposition is a plain soft-delete (the human-UI path)", async () => {
    const id = await makePage(`${PFX}-plain`);
    const r = await execute(registry, adapter, SYSTEM, "pages.delete", { pageId: id });
    expect(r.ok).toBe(true);
    expect(await isDeleted(id)).toBe(true);
    expect(await redirectsFrom(`/${PFX}-plain`)).toHaveLength(0);
  });

  it("disposition='redirect' without redirectTo is rejected", async () => {
    const id = await makePage(`${PFX}-badredir`);
    const r = await execute(registry, adapter, SYSTEM, "pages.delete", {
      pageId: id,
      disposition: "redirect",
    });
    expect(r.ok).toBe(false);
    // Rejected at validation — the page is NOT deleted.
    expect(await isDeleted(id)).toBe(false);
  });
});

describe("pages.delete_many — per-page disposition (the regression)", () => {
  it("each page in the batch gets its own disposition, all on one call", async () => {
    const a = await makePage(`${PFX}-bulk-a`); // → 301
    const b = await makePage(`${PFX}-bulk-b`); // → 404
    const c = await makePage(`${PFX}-bulk-c`); // → 301 to a different target

    const r = await execute(registry, adapter, SYSTEM, "pages.delete_many", {
      deletions: [
        { pageId: a, disposition: "redirect", redirectTo: "/home" },
        { pageId: b, disposition: "404" },
        { pageId: c, disposition: "redirect", redirectTo: "/blog" },
      ],
    });
    expect(r.ok).toBe(true);
    expect((r.value as { deleted: number }).deleted).toBe(3);

    // Before the fold this list took only `pageIds` and every page 404'd —
    // these two redirects did not exist.
    const ra = await redirectsFrom(`/${PFX}-bulk-a`);
    expect(ra).toHaveLength(1);
    expect(ra[0]?.to_path).toBe("/home");

    expect(await redirectsFrom(`/${PFX}-bulk-b`)).toHaveLength(0);

    const rc = await redirectsFrom(`/${PFX}-bulk-c`);
    expect(rc).toHaveLength(1);
    expect(rc[0]?.to_path).toBe("/blog");

    for (const id of [a, b, c]) expect(await isDeleted(id)).toBe(true);
  });
});
