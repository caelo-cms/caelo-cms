// SPDX-License-Identifier: MPL-2.0

/**
 * #1269 — `pages.list` and `content_instances.list` page through the site
 * with `limit` + `cursor`. For pages,
 * every page it returns looks as the unpaged list showed it: the chat's
 * pending deletes, renames and moves applied, the depth and the composed
 * path from the page's own ancestor chain, and `underPageId` following a
 * page the chat moved into the subtree.
 *
 * Integration tier against a throwaway Postgres (never the dev DB).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "pages-list-paging",
};
const PFX = `plp-${Date.now().toString(36)}`;
let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let templateId = "";

type Listed = { id: string; slug: string; currentPath: string; depth: number };

async function ok<T>(ctx: ExecutionContext, op: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, ctx, op, input);
  if (!r.ok) throw new Error(`${op}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function page(slug: string, parentPageId?: string): Promise<string> {
  return (
    await ok<{ pageId: string }>(SYSTEM, "pages.create", {
      slug: `${PFX}-${slug}`,
      title: slug,
      templateId,
      ...(parentPageId ? { parentPageId } : {}),
    })
  ).pageId;
}

/** Every page, in pages of `limit`, through `nextCursor`. */
async function allPaged(
  ctx: ExecutionContext,
  limit: number,
  extra: Record<string, unknown> = {},
): Promise<{ pages: Listed[]; calls: number }> {
  const pages: Listed[] = [];
  let cursor: string | null = null;
  let calls = 0;
  do {
    const r: { pages: Listed[]; nextCursor: string | null } = await ok(ctx, "pages.list", {
      ...extra,
      limit,
      ...(cursor ? { cursor } : {}),
    });
    calls += 1;
    pages.push(...r.pages);
    cursor = r.nextCursor;
  } while (cursor !== null);
  return { pages, calls };
}

const ours = (pages: Listed[]) =>
  pages
    .filter((p) => p.slug.startsWith(PFX))
    .map((p) => ({ id: p.id, path: p.currentPath, depth: p.depth }))
    .sort((a, b) => a.id.localeCompare(b.id));

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  templateId = (
    await ok<{ templateId: string }>(SYSTEM, "templates.create", {
      pageType: "home",
      slug: `${PFX}-tpl`,
      displayName: `${PFX} TPL`,
      html: `<!doctype html><html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
      css: "",
    })
  ).templateId;
  await ok(SYSTEM, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
});

afterAll(async () => {
  await adapter.close();
});

describe("#1269 — pages.list pages with limit + cursor", () => {
  it("paged pages equal the unpaged list, on main and with a chat's pending changes", async () => {
    const docs = await page("docs");
    const guide = await page("guide", docs);
    await page("step", guide);
    const blog = await page("blog");
    const post = await page("post");
    const gone = await page("gone");
    for (let i = 0; i < 5; i += 1) await page(`extra-${i}`);

    const chat = await ok<{ chatSessionId: string; chatBranchId: string }>(
      SYSTEM,
      "chat.create_session",
      { title: `${PFX}-chat` },
    );
    const ai: ExecutionContext = {
      actorId: SYSTEM.actorId,
      actorKind: "ai",
      requestId: `${PFX}-ai`,
      chatBranchId: chat.chatBranchId,
      chatTaskId: chat.chatSessionId,
    };
    await ok(ai, "pages.update", { pageId: docs, slug: `${PFX}-manual` });
    await ok(ai, "pages.delete", { pageId: gone });
    await ok(ai, "pages.move_many", { moves: [{ pageId: post, parentPageId: blog }] });

    for (const ctx of [SYSTEM, ai]) {
      const unpaged = (await ok<{ pages: Listed[] }>(ctx, "pages.list", {})).pages;
      const paged = await allPaged(ctx, 3);
      expect(ours(paged.pages)).toEqual(ours(unpaged));
      expect(paged.calls).toBeGreaterThan(3);
    }

    const onBranch = ours((await allPaged(ai, 4)).pages);
    const byId = new Map(onBranch.map((p) => [p.id, p]));
    expect(byId.get(guide)).toEqual({ id: guide, path: `/${PFX}-manual/${PFX}-guide`, depth: 2 });
    expect(byId.has(gone)).toBe(false);
    expect(byId.get(post)?.path).toBe(`/${PFX}-blog/${PFX}-post`);
    expect(byId.get(post)?.depth).toBe(2);

    // A page the chat moved under blog is in blog's subtree on the branch only.
    const under = async (ctx: ExecutionContext) =>
      ours((await allPaged(ctx, 2, { underPageId: blog })).pages).map((p) => p.id);
    expect(await under(ai)).toEqual([post]);
    expect(await under(SYSTEM)).toEqual([]);
  });

  it("content_instances.list: paged instances equal the unpaged list, with a chat's delete", async () => {
    const { moduleId } = await ok<{ moduleId: string }>(SYSTEM, "modules.create", {
      slug: `${PFX}-card`,
      displayName: `${PFX} card`,
      html: "<p>{{title}}</p>",
      fields: [{ name: "title", kind: "text", label: "Title" }],
    });
    const ids: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      ids.push(
        (
          await ok<{ contentInstanceId: string }>(SYSTEM, "content_instances.create", {
            moduleId,
            displayName: `${PFX} card ${i}`,
            purpose: "paging test",
            values: { title: `Card ${i}` },
          })
        ).contentInstanceId,
      );
    }
    const chat = await ok<{ chatSessionId: string; chatBranchId: string }>(
      SYSTEM,
      "chat.create_session",
      { title: `${PFX}-ci-chat` },
    );
    const ai: ExecutionContext = {
      actorId: SYSTEM.actorId,
      actorKind: "ai",
      requestId: `${PFX}-ci-ai`,
      chatBranchId: chat.chatBranchId,
      chatTaskId: chat.chatSessionId,
    };
    await ok(ai, "content_instances.delete", { id: ids[2] });
    type Row = { id: string };
    for (const ctx of [SYSTEM, ai]) {
      const unpaged = (
        await ok<{ instances: Row[] }>(ctx, "content_instances.list", { moduleId })
      ).instances.map((r) => r.id);
      const paged: string[] = [];
      let cursor: string | null = null;
      do {
        const r: { instances: Row[]; nextCursor: string | null } = await ok(
          ctx,
          "content_instances.list",
          { moduleId, limit: 2, ...(cursor ? { cursor } : {}) },
        );
        paged.push(...r.instances.map((x) => x.id));
        cursor = r.nextCursor;
      } while (cursor !== null);
      expect(paged).toEqual(unpaged);
    }
    const onBranch = (
      await ok<{ instances: Row[] }>(ai, "content_instances.list", { moduleId })
    ).instances.map((r) => r.id);
    expect(onBranch).not.toContain(ids[2]);
    expect(onBranch).toHaveLength(6);
  });

  it("refuses a cursor without limit and a cursor it did not issue", async () => {
    const noLimit = await execute(registry, adapter, SYSTEM, "pages.list", { cursor: "abc" });
    expect(noLimit.ok).toBe(false);
    const forged = await execute(registry, adapter, SYSTEM, "pages.list", {
      limit: 5,
      cursor: "bm90LWEtY3Vyc29y",
    });
    expect(forged.ok).toBe(false);
    if (!forged.ok) expect(JSON.stringify(forged.error)).toContain("nextCursor");
  });
});
