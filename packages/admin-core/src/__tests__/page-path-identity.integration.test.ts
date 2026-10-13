// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #690 part 2 — page identity is the id, the URL PATH is unique.
 *
 * - the same slug lives under two parents (`/a/x`, `/b/x`);
 * - a move onto a taken path is refused naming the clash, and succeeds
 *   in ONE call with `newSlug` (redirect from the old URL);
 * - creating / duplicating onto a taken path is refused;
 * - a slug-only page reference that matches two pages fails loudly with
 *   both paths (tool layer); a path or id resolves;
 * - a module-delete refusal names the placing pages by path.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { resolvePageRef } from "../ai/tools/_page-ref.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "page-path-identity-int",
};
const PFX = "pid690";
let templateId: string;

async function q<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL!);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as SQL);
    });
  } finally {
    await sql.end();
  }
}

async function pathOf(pageId: string): Promise<string> {
  const rows = (await q(
    (tx) => tx`SELECT current_path FROM pages WHERE id = ${pageId}::uuid`,
  )) as unknown as { current_path: string }[];
  return rows[0]?.current_path ?? "<missing>";
}

async function makePage(slug: string, parentPageId?: string): Promise<string> {
  const r = await execute(registry, adapter, SYSTEM, "pages.create", {
    slug: `${PFX}-${slug}`,
    title: slug,
    templateId,
    ...(parentPageId ? { parentPageId } : {}),
  });
  if (!r.ok) throw new Error(`page ${slug}: ${JSON.stringify(r.error)}`);
  return (r.value as { pageId: string }).pageId;
}

function errMsg(r: { ok: boolean; error?: unknown }): string {
  return r.ok ? "" : String((r.error as { message?: string }).message ?? "");
}

async function wipe(): Promise<void> {
  await q(async (tx) => {
    await tx`DELETE FROM redirects WHERE from_path LIKE ${`%${PFX}-%`} OR to_path LIKE ${`%${PFX}-%`}`;
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}-%`})`;
    await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}-%`}`;
    await tx`DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE slug LIKE ${`${PFX}-%`})`;
    await tx`DELETE FROM modules WHERE slug LIKE ${`${PFX}-%`}`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE ${`${PFX}-%`})`;
    await tx`DELETE FROM templates WHERE slug LIKE ${`${PFX}-%`}`;
  });
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  const tpl = await execute(registry, adapter, SYSTEM, "templates.create", {
    slug: `${PFX}-tpl`,
    displayName: "PID T",
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

describe("page identity is the id; the URL path is unique", () => {
  let a: string;
  let b: string;
  let xa: string;
  let xb: string;

  it("the same slug lives under two parents", async () => {
    a = await makePage("a");
    b = await makePage("b");
    xa = await makePage("x", a);
    xb = await makePage("x", b);
    expect(await pathOf(xa)).toBe(`/${PFX}-a/${PFX}-x`);
    expect(await pathOf(xb)).toBe(`/${PFX}-b/${PFX}-x`);
  });

  it("a move onto a taken path is refused naming the clash; newSlug moves + renames in one call", async () => {
    const refused = await execute(registry, adapter, SYSTEM, "pages.move_many", {
      moves: [{ pageId: xb, parentPageId: a }],
    });
    expect(refused.ok).toBe(false);
    expect(errMsg(refused)).toContain(`/${PFX}-a/${PFX}-x`);
    expect(errMsg(refused)).toContain("newSlug");
    expect(await pathOf(xb)).toBe(`/${PFX}-b/${PFX}-x`);

    const moved = await execute(registry, adapter, SYSTEM, "pages.move_many", {
      moves: [{ pageId: xb, parentPageId: a, newSlug: `${PFX}-x2` }],
    });
    expect(moved.ok).toBe(true);
    expect(await pathOf(xb)).toBe(`/${PFX}-a/${PFX}-x2`);
    const red = (await q(
      (tx) => tx`SELECT to_path FROM redirects WHERE from_path = ${`/${PFX}-b/${PFX}-x`}`,
    )) as unknown as { to_path: string }[];
    expect(red[0]?.to_path).toBe(`/${PFX}-a/${PFX}-x2`);
  });

  it("create and duplicate onto a taken path are refused", async () => {
    const dupCreate = await execute(registry, adapter, SYSTEM, "pages.create", {
      slug: `${PFX}-x`,
      title: "dup",
      templateId,
      parentPageId: a,
    });
    expect(dupCreate.ok).toBe(false);
    expect(errMsg(dupCreate)).toMatch(/page already exists at/);

    const dupCopy = await execute(registry, adapter, SYSTEM, "pages.duplicate", {
      sourcePageId: xa,
      newSlug: `${PFX}-x2`,
    });
    expect(dupCopy.ok).toBe(false);
    expect(errMsg(dupCopy)).toMatch(/page already exists at/);

    // The same slug elsewhere is fine.
    const elsewhere = await execute(registry, adapter, SYSTEM, "pages.duplicate", {
      sourcePageId: xa,
      newSlug: `${PFX}-x`,
      newParentPageId: b,
    });
    expect(elsewhere.ok).toBe(true);
  });

  it("an ambiguous slug reference fails loudly; path and id resolve", async () => {
    const toolCtx = { registry, adapter } as Parameters<typeof resolvePageRef>[1];
    const ambiguous = await resolvePageRef(SYSTEM, toolCtx, `${PFX}-x`);
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) {
      expect(ambiguous.message).toContain(`/${PFX}-a/${PFX}-x`);
      expect(ambiguous.message).toContain(`/${PFX}-b/${PFX}-x`);
    }
    const byPath = await resolvePageRef(SYSTEM, toolCtx, `/${PFX}-a/${PFX}-x/`);
    expect(byPath).toEqual({ ok: true, pageId: xa });
    const byId = await resolvePageRef(SYSTEM, toolCtx, xa);
    expect(byId).toEqual({ ok: true, pageId: xa });
  });

  it("a module-delete refusal names the placing pages by path", async () => {
    const mod = await execute(registry, adapter, SYSTEM, "modules.create", {
      slug: `${PFX}-mod`,
      displayName: "PID mod",
      html: "<p>x</p>",
      fields: [{ name: "body", kind: "text", label: "Body" } as never],
    });
    if (!mod.ok) throw new Error("module seed");
    const moduleId = (mod.value as { moduleId: string }).moduleId;
    const ci = await execute(registry, adapter, SYSTEM, "content_instances.create", {
      moduleId,
      values: {},
    });
    if (!ci.ok) throw new Error(`ci seed ${JSON.stringify(ci.error)}`);
    const ciId =
      (ci.value as { contentInstanceId?: string; id?: string }).contentInstanceId ??
      (ci.value as { id: string }).id;
    await q(
      (
        tx,
      ) => tx`INSERT INTO page_modules (page_id, block_name, position, module_id, content_instance_id, sync_mode)
        VALUES (${xa}::uuid, 'content', 0, ${moduleId}::uuid, ${ciId}::uuid, 'unsynced')`,
    );
    // The placement guard is the AI's (a human delete is their decision).
    const del = await execute(
      registry,
      adapter,
      { ...SYSTEM, actorId: "00000000-0000-0000-0000-000000000a1a", actorKind: "ai" },
      "modules.delete",
      { moduleId },
    );
    expect(del.ok).toBe(false);
    expect(errMsg(del)).toContain(`/${PFX}-a/${PFX}-x`);
  });
});
