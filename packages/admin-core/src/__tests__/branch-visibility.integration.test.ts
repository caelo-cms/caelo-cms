// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #569 — a chat branch is visible only to the people allowed to see
 * it, on every surface that names one.
 *
 * Pre-fix, `/edit/preview/<page>?branch=<id>` handed the id straight to
 * `pages.render_preview` (and `/edit/preview-by-path` also put it on the
 * ExecutionContext), and nothing checked it: any editor who knew or
 * guessed a branch id saw another editor's unpublished experiment. The
 * Query API adapter now checks every branch an op names — context
 * `chatBranchId` and input `chatBranchId` — against the caller before the
 * handler runs (`caelo_branch_visible`, migration 0249):
 *
 *   - the shared site draft: every editor;
 *   - an isolated branch (experiment / migration / legacy): the owner of a
 *     chat bound to it, or a role holding `drafts.view_all` (Owner);
 *   - the AI in a chat: what that chat's owner may see;
 *   - system actors (static generator, signed screenshot render): always.
 *
 * Unauthorized and nonexistent branches get the same `BranchNotFound`, so a
 * guessed id confirms nothing; the preview routes map it to 404.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR = "00000000-0000-0000-0000-00000000ffff";
const PFX = `t569-${Date.now()}-`;
const SYS: ExecutionContext = { actorId: SYSTEM_ACTOR, actorKind: "system", requestId: "t569" };

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

async function asSystem<T>(query: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return (await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return query(tx as unknown as SQL);
    })) as T;
  } finally {
    await sql.end();
  }
}

/** A signed-in person with one built-in role; returns their human ctx. */
async function person(role: "owner" | "editor", label: string): Promise<ExecutionContext> {
  const id = crypto.randomUUID();
  await asSystem(async (tx) => {
    await tx`INSERT INTO actors (id, kind, display_name) VALUES (${id}::uuid, 'human', ${PFX + label})`;
    await tx`INSERT INTO users (id, email, password_hash) VALUES (${id}::uuid, ${`${PFX}${label}@t569.test`}, 'test-only')`;
    await tx`INSERT INTO user_roles (user_id, role_id) SELECT ${id}::uuid, id FROM roles WHERE name = ${role}`;
  });
  return { actorId: id, actorKind: "human", requestId: `t569-${label}` };
}

async function op<T>(ctx: ExecutionContext, name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

interface Chat {
  id: string;
  branch: string;
  /** The AI working in this chat (what the chat-runner hands every tool). */
  ai: ExecutionContext;
}

async function chat(owner: ExecutionContext, title: string, isolated: boolean): Promise<Chat> {
  const v = await op<{ chatSessionId: string; chatBranchId: string }>(
    owner,
    "chat.create_session",
    { title: `${PFX}${title}`, ...(isolated ? { isolation: "experiment" } : {}) },
  );
  return {
    id: v.chatSessionId,
    branch: v.chatBranchId,
    ai: {
      actorId: SYSTEM_ACTOR,
      actorKind: "ai",
      requestId: `t569-ai-${title}`,
      chatBranchId: v.chatBranchId,
      chatTaskId: v.chatSessionId,
    },
  };
}

let editorA: ExecutionContext;
let editorB: ExecutionContext;
let owner: ExecutionContext;
let experimentA: Chat;
let draftA: Chat;
let chatB: Chat;
let pageId: string;
let moduleId: string;

/** Render the page on `branch` as `ctx`, the way the preview routes do. */
function preview(ctx: ExecutionContext, branch: string) {
  return execute(registry, adapter, ctx, "pages.render_preview", { pageId, chatBranchId: branch });
}

function expectBranchNotFound(r: { ok: boolean; error?: unknown }, branch: string): void {
  expect(r.ok).toBe(false);
  expect(r.error).toMatchObject({ kind: "BranchNotFound", chatBranchId: branch });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);

  editorA = await person("editor", "editor-a");
  editorB = await person("editor", "editor-b");
  owner = await person("owner", "owner");

  // A live page with one module, so a branch edit of the module shows in
  // the branch's preview.
  await asSystem(async (tx) => {
    const tpl = (await tx`
      INSERT INTO templates (slug, display_name, html, layout_id)
      VALUES (${`${PFX}tpl`}, 'T569 tpl', '<body><caelo-slot name="content">_</caelo-slot></body>',
              (SELECT id FROM layouts WHERE slug = 'site-default'))
      RETURNING id::text AS id
    `) as unknown as { id: string }[];
    const templateId = tpl[0]?.id as string;
    await tx`INSERT INTO template_blocks (template_id, name, display_name, position)
             VALUES (${templateId}::uuid, 'content', 'Content', 0)`;
    const mod = (await tx`
      INSERT INTO modules (slug, display_name, type, html, fields)
      VALUES (${`${PFX}mod`}, 'T569 module', ${`${PFX}mod`}, '<p>live copy</p>', '[]'::jsonb)
      RETURNING id::text AS id
    `) as unknown as { id: string }[];
    moduleId = mod[0]?.id as string;
    const ci = (await tx`
      INSERT INTO content_instances (module_id, "values") VALUES (${moduleId}::uuid, '{}'::jsonb)
      RETURNING id::text AS id
    `) as unknown as { id: string }[];
    const page = (await tx`
      INSERT INTO pages (slug, name, title, template_id)
      VALUES (${`${PFX}page`}, 'T569', 'T569', ${templateId}::uuid)
      RETURNING id::text AS id
    `) as unknown as { id: string }[];
    pageId = page[0]?.id as string;
    await tx`INSERT INTO page_modules (page_id, block_name, position, module_id, content_instance_id, sync_mode)
             VALUES (${pageId}::uuid, 'content', 0, ${moduleId}::uuid, ${ci[0]?.id}::uuid, 'unsynced')`;
  });

  // Editor A runs an isolated experiment that rewrites the module, and also
  // has a chat in the shared draft. Editor B has a draft chat of their own.
  experimentA = await chat(editorA, "experiment-a", true);
  draftA = await chat(editorA, "draft-a", false);
  chatB = await chat(editorB, "chat-b", false);
  await op(experimentA.ai, "modules.update", { moduleId, html: "<p>secret experiment</p>" });
});

afterAll(async () => {
  await adapter.close();
});

describe("#569 branch visibility", () => {
  it("binds the experiment to its own branch and the draft chats to the shared draft", () => {
    expect(experimentA.branch).not.toBe(draftA.branch);
    expect(chatB.branch).toBe(draftA.branch);
  });

  it("lets editor A preview their own experiment", async () => {
    const r = await preview(editorA, experimentA.branch);
    expect(r.ok).toBe(true);
    expect((r.value as { html: string }).html).toContain("secret experiment");
  });

  it("answers editor B's request for A's experiment as not found (input branch)", async () => {
    expectBranchNotFound(await preview(editorB, experimentA.branch), experimentA.branch);
  });

  it("answers the same for a branch id that does not exist", async () => {
    const ghost = crypto.randomUUID();
    const r = await preview(editorB, ghost);
    expectBranchNotFound(r, ghost);
    // Same message shape for both: nothing tells B the experiment exists.
    const real = await preview(editorB, experimentA.branch);
    const msg = (x: typeof r) => (x.error as { message: string }).message;
    expect(msg(real).replace(experimentA.branch, "<id>")).toBe(msg(r).replace(ghost, "<id>"));
  });

  it("refuses A's branch on the context too (preview-by-path's page lookup)", async () => {
    const r = await execute(
      registry,
      adapter,
      { ...editorB, chatBranchId: experimentA.branch },
      "pages.list",
      {},
    );
    expectBranchNotFound(r, experimentA.branch);
  });

  it("refuses a write onto A's branch and leaves it untouched", async () => {
    const r = await execute(
      registry,
      adapter,
      { ...editorB, chatBranchId: experimentA.branch },
      "modules.update",
      { moduleId, html: "<p>overwritten by B</p>" },
    );
    expectBranchNotFound(r, experimentA.branch);
    const after = await preview(editorA, experimentA.branch);
    expect((after.value as { html: string }).html).toContain("secret experiment");
  });

  it("refuses a malformed branch id instead of failing the cast", async () => {
    const r = await execute(
      registry,
      adapter,
      { ...editorB, chatBranchId: "not-a-uuid" },
      "pages.list",
      {},
    );
    expectBranchNotFound(r, "not-a-uuid");
  });

  it("shows the shared draft to every editor", async () => {
    expect((await preview(editorB, draftA.branch)).ok).toBe(true);
    expect((await preview(editorA, chatB.branch)).ok).toBe(true);
  });

  it("lets the Owner (drafts.view_all) see any editor's branch", async () => {
    const r = await preview(owner, experimentA.branch);
    expect(r.ok).toBe(true);
    expect((r.value as { html: string }).html).toContain("secret experiment");
  });

  it("gives the AI in a chat exactly what the chat's owner may see", async () => {
    // A's chat AI sees A's experiment; B's chat AI does not.
    expect((await preview(draftA.ai, experimentA.branch)).ok).toBe(true);
    expectBranchNotFound(await preview(chatB.ai, experimentA.branch), experimentA.branch);
    // The explicit check the server-side screenshot path runs first.
    const check = await execute(registry, adapter, chatB.ai, "chat.check_branch_access", {
      chatBranchId: experimentA.branch,
    });
    expectBranchNotFound(check, experimentA.branch);
    expect(
      await op(draftA.ai, "chat.check_branch_access", { chatBranchId: experimentA.branch }),
    ).toEqual({ visible: true });
  });

  it("keeps system actors (static generator, signed screenshot render) working", async () => {
    const r = await preview(SYS, experimentA.branch);
    expect(r.ok).toBe(true);
    expect((r.value as { html: string }).html).toContain("secret experiment");
    const tx = await adapter.withAdminTransaction(
      { ...SYS, chatBranchId: experimentA.branch },
      async () => "ran",
    );
    expect(tx).toBe("ran");
  });

  it("refuses withAdminTransaction on a branch the human may not see", async () => {
    await expect(
      adapter.withAdminTransaction({ ...editorB, chatBranchId: experimentA.branch }, async () => 1),
    ).rejects.toThrow(/branch not found/);
  });
});
