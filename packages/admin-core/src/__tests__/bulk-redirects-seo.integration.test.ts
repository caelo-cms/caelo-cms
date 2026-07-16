// SPDX-License-Identifier: MPL-2.0

/**
 * Dedicated coverage for three bulk AI tools that had none:
 *   - bulk_create_redirects  → redirects.create_many
 *   - bulk_delete_redirects   → redirects.delete_many (happy paths; the
 *     AI matches-≥10 gate is covered separately in
 *     redirects-bulk-delete-gate.integration.test.ts)
 *   - bulk_optimize_seo       → pages_seo.optimize_many
 *
 * Real Postgres (§6).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { bulkCreateRedirectsTool } from "../ai/tools/bulk-create-redirects.js";
import { bulkDeleteRedirectsTool } from "../ai/tools/bulk-delete-redirects.js";
import { bulkOptimizeSeoTool } from "../ai/tools/bulk-optimize-seo.js";
import type { ToolContext } from "../ai/tools/dispatch.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "bulk-redir-seo-int",
};

const PFX = "bulkrs";
let templateId: string;
const toolCtx = () => ({ adapter, registry }) as ToolContext;

async function countRedirectsUnder(prefix: string): Promise<number> {
  const sql = new SQL(ADMIN_URL!);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const r = (await tx`
        SELECT count(*)::int AS n FROM redirects WHERE from_path LIKE ${`${prefix}%`}
      `) as unknown as { n: number }[];
      return r[0]?.n ?? 0;
    });
  } finally {
    await sql.end();
  }
}

async function makePage(slug: string): Promise<string> {
  const r = await execute(registry, adapter, SYSTEM, "pages.create", {
    slug,
    title: slug,
    templateId,
  });
  if (!r.ok) throw new Error(`page ${slug}`);
  return (r.value as { pageId: string }).pageId;
}

async function metaOf(pageId: string): Promise<string | null> {
  const r = await execute(registry, adapter, SYSTEM, "pages_seo.get", { pageId });
  if (!r.ok) return null;
  const seo = (r.value as { seo: { metaDescription: string | null } | null }).seo;
  return seo?.metaDescription ?? null;
}

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM redirects WHERE from_path LIKE ${`/${PFX}-%`}`;
      await tx`DELETE FROM pages_seo WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}-%`})`;
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
    slug: `${PFX}-tpl`,
    displayName: "T",
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

describe("bulk_create_redirects", () => {
  it("creates several redirects in one call", async () => {
    const r = await bulkCreateRedirectsTool.handler(
      SYSTEM,
      {
        redirects: [
          { fromPath: `/${PFX}-a`, toPath: "/home" },
          { fromPath: `/${PFX}-b`, toPath: "/home", statusCode: 302 },
          { fromPath: `/${PFX}-c`, toPath: "/blog" },
        ],
      },
      toolCtx(),
    );
    expect(r.ok).toBe(true);
    expect(await countRedirectsUnder(`/${PFX}-`)).toBe(3);
  });
});

describe("bulk_delete_redirects", () => {
  it("deletes by explicit fromPaths", async () => {
    await bulkCreateRedirectsTool.handler(
      SYSTEM,
      {
        redirects: [
          { fromPath: `/${PFX}-del1`, toPath: "/home" },
          { fromPath: `/${PFX}-del2`, toPath: "/home" },
          { fromPath: `/${PFX}-keep`, toPath: "/home" },
        ],
      },
      toolCtx(),
    );

    const r = await bulkDeleteRedirectsTool.handler(
      SYSTEM,
      { fromPaths: [`/${PFX}-del1`, `/${PFX}-del2`] },
      toolCtx(),
    );
    expect(r.ok).toBe(true);
    // The two named ones are gone; the keep one stays.
    expect(await countRedirectsUnder(`/${PFX}-del`)).toBe(0);
    expect(await countRedirectsUnder(`/${PFX}-keep`)).toBe(1);
  });

  it("a substring `matches` delete works for a SYSTEM actor (no AI cap)", async () => {
    // 3 rows under one prefix. The ≥10 cap is AI-only; SYSTEM is unbounded.
    await bulkCreateRedirectsTool.handler(
      SYSTEM,
      {
        redirects: [
          { fromPath: `/${PFX}-m1`, toPath: "/x" },
          { fromPath: `/${PFX}-m2`, toPath: "/x" },
          { fromPath: `/${PFX}-m3`, toPath: "/x" },
        ],
      },
      toolCtx(),
    );
    const r = await bulkDeleteRedirectsTool.handler(SYSTEM, { matches: `${PFX}-m` }, toolCtx());
    expect(r.ok).toBe(true);
    expect(await countRedirectsUnder(`/${PFX}-m`)).toBe(0);
  });
});

describe("bulk_optimize_seo", () => {
  it("sets meta descriptions across several pages in one call", async () => {
    const a = await makePage(`${PFX}-p1`);
    const b = await makePage(`${PFX}-p2`);
    const r = await bulkOptimizeSeoTool.handler(
      SYSTEM,
      {
        context: "rebrand from Foo to Bar",
        updates: [
          { pageId: a, metaDescription: "Bar — the first page." },
          { pageId: b, metaDescription: "Bar — the second page." },
        ],
      },
      toolCtx(),
    );
    expect(r.ok).toBe(true);
    expect(await metaOf(a)).toBe("Bar — the first page.");
    expect(await metaOf(b)).toBe("Bar — the second page.");
  });
});
