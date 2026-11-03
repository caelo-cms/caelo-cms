// SPDX-License-Identifier: MPL-2.0

/**
 * #1269 — humanising a read resolves only the pages and media it names,
 * and gives them the same paths as the full branch view
 * (`loadLinkTargets`): the stored path while nothing above the page moved
 * on the branch, the composed path once a page above it was renamed, and
 * no path for a page the branch deleted.
 *
 * Integration tier against a throwaway Postgres (never the dev DB).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { humaniseForRead } from "../links/humanise.js";
import { loadLinkTargets } from "../links/link-targets.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "links-humanise-scoped",
};
const PFX = `lhs-${Date.now().toString(36)}`;
let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let templateId = "";

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

/** What a read of `{ link }` shows the caller. */
async function shown(ctx: ExecutionContext, pageId: string): Promise<string> {
  const out = await adapter.withAdminTransaction(ctx, (tx) =>
    humaniseForRead(tx, ctx, { link: `caelo:page/${pageId}` }),
  );
  return out.link;
}

/** The path the full branch view gives the page (null = not a target). */
async function fullView(ctx: ExecutionContext, pageId: string): Promise<string | null> {
  const t = await adapter.withAdminTransaction(ctx, (tx) =>
    loadLinkTargets(tx, ctx.chatBranchId ?? null),
  );
  return t.pages.find((p) => p.id === pageId)?.path ?? null;
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

describe("#1269 — humanising resolves the named pages only, with the branch's paths", () => {
  it("stored path, composed path after a rename above, raw after a delete — as the full view", async () => {
    const parent = await page("parent");
    const child = await page("child", parent);
    const other = await page("other");
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

    const childPath = `/${PFX}-parent/${PFX}-child`;
    expect(await shown(SYSTEM, child)).toBe(childPath);
    expect(await shown(ai, child)).toBe(childPath);

    // A rename above the child on the draft: the chat sees the composed
    // path, main keeps the stored one.
    await ok(ai, "pages.update", { pageId: parent, slug: `${PFX}-renamed` });
    expect(await shown(ai, child)).toBe(`/${PFX}-renamed/${PFX}-child`);
    expect(await shown(SYSTEM, child)).toBe(childPath);
    expect(await shown(ai, child)).toBe((await fullView(ai, child)) as string);

    // A page the branch deleted is no target there: the reference stays raw.
    await ok(ai, "pages.delete", { pageId: other });
    expect(await shown(ai, other)).toBe(`caelo:page/${other}`);
    expect(await fullView(ai, other)).toBeNull();
    expect(await shown(SYSTEM, other)).toBe(`/${PFX}-other`);
  });
});
