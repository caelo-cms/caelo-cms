// SPDX-License-Identifier: MPL-2.0

/**
 * #1269 — `site_defaults.get` reports the page core composes at "/"
 * (`rootPageId`) without reading the page tree, and gives the same answer
 * as the tree: the stored root on main, and on a chat's branch the root its
 * pending renames make — none once the chat renamed the root away, the
 * page the chat renamed to a magic slug after that, and the designated
 * home whenever one is set.
 *
 * Integration tier against a throwaway Postgres (never the dev DB).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { type ExecutionContext, isHomeSlug } from "@caelo-cms/shared";
import { loadPageTree } from "../ops/content/page-tree.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "site-defaults-root",
};
const PFX = `sdr-${Date.now().toString(36)}`;
let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let templateId = "";

async function ok<T>(ctx: ExecutionContext, op: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, ctx, op, input);
  if (!r.ok) throw new Error(`${op}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function rootOf(ctx: ExecutionContext): Promise<string | null> {
  const r = await ok<{ defaults: { rootPageId: string | null } }>(ctx, "site_defaults.get", {});
  return r.defaults.rootPageId;
}

/** The root as the whole page tree of the caller's view says (the rule before #1269). */
async function treeRoot(ctx: ExecutionContext): Promise<string | null> {
  const tree = await adapter.withAdminTransaction(ctx, (tx) =>
    loadPageTree(tx, ctx.chatBranchId ?? null),
  );
  const roots = [...tree.byId.values()]
    .filter((n) => n.parentPageId === null && isHomeSlug(n.slug))
    .map((n) => n.id)
    .sort();
  return roots[0] ?? null;
}

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

describe("#1269 — site_defaults.get finds the root without the page tree", () => {
  it("follows a chat's pending renames of the root, as the tree does", async () => {
    const create = async (slug: string) =>
      (await ok<{ pageId: string }>(SYSTEM, "pages.create", { slug, title: slug, templateId }))
        .pageId;
    const home = await create("home");
    const about = await create(`${PFX}-about`);
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

    expect(await rootOf(SYSTEM)).toBe(home);
    expect(await rootOf(ai)).toBe(home);

    // The chat renames the root away: no root on its branch, main keeps it.
    await ok(ai, "pages.update", { pageId: home, slug: `${PFX}-old-home` });
    expect(await rootOf(ai)).toBeNull();
    expect(await treeRoot(ai)).toBeNull();
    expect(await rootOf(SYSTEM)).toBe(home);

    // ... then gives another page a magic slug: that page is the branch's root.
    await ok(ai, "pages.update", { pageId: about, slug: "index" });
    expect(await rootOf(ai)).toBe(about);
    expect(await treeRoot(ai)).toBe(about);
    expect(await rootOf(SYSTEM)).toBe(await treeRoot(SYSTEM));

    // A designated home wins outright.
    await ok(SYSTEM, "pages.set_home_page", { pageId: about });
    expect(await rootOf(SYSTEM)).toBe(about);
  });
});
