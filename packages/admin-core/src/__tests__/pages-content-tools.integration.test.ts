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
import { forkPlacementContentTool } from "../ai/tools/fork-placement-content.js";
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
      await tx`DELETE FROM chat_sessions WHERE title LIKE ${`${PFX}-%`}`;
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
      { sourcePageId: pageId, newSlug: `${PFX}-clone`, newShortTitle: "Clone" },
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

  // #63 — the refusal once named propose_delete_content_instance, a tool
  // that never existed, leaving the AI at a dead end. It must point at
  // the real detach path, and following that path must make the delete pass.
  it("delete_content_instance on a bound instance points at a working detach path", async () => {
    const instId = await seedInstance("Shared");
    const bind = await setPlacementContentTool.handler(
      SYSTEM,
      { pageId, blockName: "content", position: 0, contentInstanceId: instId, syncMode: "synced" },
      toolCtx(),
    );
    expect(bind.ok).toBe(true);

    const refused = await deleteContentInstanceTool.handler(SYSTEM, { id: instId }, toolCtx());
    expect(refused.ok).toBe(false);
    expect(refused.content).not.toContain("propose_delete_content_instance");
    expect(refused.content).toContain("fork_placement_content");
    // The refusal carries fork_placement_content's exact arguments.
    expect(refused.content).toContain(`pageId ${pageId}, blockName content, position 0`);

    const fork = await forkPlacementContentTool.handler(
      SYSTEM,
      { pageId, blockName: "content", position: 0 },
      toolCtx(),
    );
    expect(fork.ok).toBe(true);
    const del = await deleteContentInstanceTool.handler(SYSTEM, { id: instId }, toolCtx());
    expect(del.ok).toBe(true);
  });

  // PR #947 review — in a chat the fork rebinds only the branch layout, so
  // a live-only placement count kept refusing the retry; and the delete
  // itself soft-deleted the LIVE row from inside the chat.
  it("detach-then-delete works inside a chat and stays off the live site until merge", async () => {
    const instId = await seedInstance("SharedInChat");
    const bind = await setPlacementContentTool.handler(
      SYSTEM,
      { pageId, blockName: "content", position: 0, contentInstanceId: instId, syncMode: "synced" },
      toolCtx(),
    );
    expect(bind.ok).toBe(true);
    const s = await execute(registry, adapter, SYSTEM, "chat.create_session", {
      isolation: "experiment",
      title: `${PFX}-chat`,
    });
    if (!s.ok) throw new Error(JSON.stringify(s.error));
    const { chatSessionId, chatBranchId } = s.value as {
      chatSessionId: string;
      chatBranchId: string;
    };
    const ai: ExecutionContext = {
      actorId: "00000000-0000-0000-0000-000000000a1a",
      actorKind: "ai",
      requestId: "pages-content-int-chat",
      chatBranchId,
      chatTaskId: chatSessionId,
    };

    const refused = await deleteContentInstanceTool.handler(ai, { id: instId }, toolCtx());
    expect(refused.ok).toBe(false);
    const fork = await forkPlacementContentTool.handler(
      ai,
      { pageId, blockName: "content", position: 0 },
      toolCtx(),
    );
    expect(fork.ok).toBe(true);
    const del = await deleteContentInstanceTool.handler(ai, { id: instId }, toolCtx());
    expect(del.ok).toBe(true);
    expect(await liveDeletedAt(instId)).toBeNull();

    const merged = await execute(registry, adapter, SYSTEM, "chat.merge_to_main", {
      chatSessionId,
    });
    if (!merged.ok) throw new Error(JSON.stringify(merged.error));
    expect(await liveDeletedAt(instId)).not.toBeNull();
    const bound = await liveBinding(pageId);
    expect(bound).not.toBe(instId);
  });
});

async function liveDeletedAt(id: string): Promise<Date | null> {
  const sql = new SQL(ADMIN_URL!);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const rows = (await tx`SELECT deleted_at FROM content_instances WHERE id = ${id}::uuid`) as {
        deleted_at: Date | null;
      }[];
      return rows[0]?.deleted_at ?? null;
    });
  } finally {
    await sql.end();
  }
}

async function liveBinding(page: string): Promise<string | undefined> {
  const sql = new SQL(ADMIN_URL!);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const rows = (await tx`
        SELECT content_instance_id::text AS ci FROM page_modules
        WHERE page_id = ${page}::uuid AND block_name = 'content' AND position = 0
      `) as { ci: string }[];
      return rows[0]?.ci;
    });
  } finally {
    await sql.end();
  }
}
