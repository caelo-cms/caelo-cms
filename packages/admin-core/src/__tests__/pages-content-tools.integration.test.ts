// SPDX-License-Identifier: MPL-2.0

/**
 * Coverage for page + content-instance tools that had no dedicated test:
 * duplicate_page, get_page_log, inspect_built_page (no-build path),
 * delete_content_instance, set_placement_content. Real Postgres (§6).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { createContentInstanceTool } from "../ai/tools/create-content-instance.js";
import { deleteContentInstanceTool } from "../ai/tools/delete-content-instance.js";
import type { ToolContext } from "../ai/tools/dispatch.js";
import { duplicatePageTool } from "../ai/tools/duplicate-page.js";
import { getPageLogTool } from "../ai/tools/get-page-log.js";
import { inspectBuiltPageTool } from "../ai/tools/inspect-built-page.js";
import { setPlacementContentTool } from "../ai/tools/set-placement-content.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "pages-content-int",
};

const PFX = "pgct";
let templateId: string;
let pageId: string;
let moduleId: string;
const toolCtx = () => ({ adapter, registry }) as ToolContext;

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      // page_modules FK-references content_instances, so drop placements first.
      await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}-%`})`;
      await tx`DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE slug LIKE ${`${PFX}-%`})`;
      await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}-%`}`;
      await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE ${`${PFX}-%`})`;
      await tx`DELETE FROM templates WHERE slug LIKE ${`${PFX}-%`}`;
      await tx`DELETE FROM modules WHERE slug LIKE ${`${PFX}-%`}`;
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
  const pg = await execute(registry, adapter, SYSTEM, "pages.create", {
    slug: `${PFX}-page`,
    title: "P",
    templateId,
  });
  if (!pg.ok) throw new Error("page");
  pageId = (pg.value as { pageId: string }).pageId;
  const mod = await execute(registry, adapter, SYSTEM, "modules.create", {
    slug: `${PFX}-mod`,
    displayName: "M",
    html: "<div>{{body}}</div>",
    fields: [{ name: "body", kind: "text", label: "Body" } as never],
  });
  if (!mod.ok) throw new Error("module");
  moduleId = (mod.value as { moduleId: string }).moduleId;
  await execute(registry, adapter, SYSTEM, "pages.set_modules", {
    pageId,
    blocks: [{ blockName: "content", moduleIds: [moduleId] }],
  });
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("duplicate_page", () => {
  it("clones a page under a new slug", async () => {
    const r = await duplicatePageTool.handler(
      SYSTEM,
      { sourcePageId: pageId, newSlug: `${PFX}-clone`, newName: "Clone" },
      toolCtx(),
    );
    expect(r.ok).toBe(true);
    const listed = await execute(registry, adapter, SYSTEM, "pages.list", {});
    if (!listed.ok) throw new Error("list");
    expect(
      (listed.value as { pages: { slug: string }[] }).pages.some((p) => p.slug === `${PFX}-clone`),
    ).toBe(true);
  });
});

describe("get_page_log", () => {
  it("returns the page's edit log (empty is fine)", async () => {
    const r = await getPageLogTool.handler(SYSTEM, { pageId }, toolCtx());
    expect(r.ok).toBe(true);
  });
});

describe("inspect_built_page", () => {
  it("fails gracefully when the page has no build yet (no crash)", async () => {
    const r = await inspectBuiltPageTool.handler(SYSTEM, { pageId }, toolCtx());
    // No deploy build exists in the test DB — the tool must return a clean
    // ok:false, not throw.
    expect(typeof r.ok).toBe("boolean");
    expect(r.ok).toBe(false);
  });
});

describe("content instances", () => {
  /** Seed a content instance via the op, returning its id. */
  async function seedInstance(name: string): Promise<string> {
    const r = await execute(registry, adapter, SYSTEM, "content_instances.create", {
      moduleId,
      displayName: name,
      values: { body: "copy" },
    });
    if (!r.ok) throw new Error(`seed instance: ${JSON.stringify(r.error)}`);
    return (r.value as { contentInstanceId: string }).contentInstanceId;
  }

  it("create_content_instance mints an instance, delete_content_instance removes it", async () => {
    // create via the tool (coverage), then delete via the tool.
    const created = await createContentInstanceTool.handler(
      SYSTEM,
      { moduleId, displayName: "Inst", values: { body: "hi" } },
      toolCtx(),
    );
    expect(created.ok).toBe(true);
    const id = await seedInstance("ToDelete");

    const del = await deleteContentInstanceTool.handler(SYSTEM, { id }, toolCtx());
    expect(del.ok).toBe(true);
  });

  it("set_placement_content binds a content instance to a placement", async () => {
    const instId = await seedInstance("Bound");
    const r = await setPlacementContentTool.handler(
      SYSTEM,
      {
        pageId,
        blockName: "content",
        position: 0,
        contentInstanceId: instId as string,
        syncMode: "unsynced",
      },
      toolCtx(),
    );
    expect(r.ok).toBe(true);
  });
});
