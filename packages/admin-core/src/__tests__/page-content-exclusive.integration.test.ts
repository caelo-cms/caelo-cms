// SPDX-License-Identifier: MPL-2.0

/**
 * #1309 — nested content is a page's own only when nothing ABOVE it
 * renders on another page too.
 *
 * `page_module_content.list_for_page` marks each nested instance
 * `exclusive`, and `page_module_content.set` with a `nestedPath` writes
 * only exclusive ones (international-site's translator writes a
 * language version through it). The check used to look one level up: an
 * instance whose parents all sat in the page's tree counted as the
 * page's own, even when the placement above them was bound to the same
 * instance as another page. A translation then wrote English into the
 * second-level content of the German source page. Shapes covered:
 *
 *   - both pages bind the same root (a synced placement): every level
 *     below it is shared;
 *   - the variant owns its root, but the root still lists the source's
 *     nested instances (a variant copied before nested content was
 *     deep-copied): the first level AND the levels below it are shared;
 *   - the nested write is refused with the fork as the next step; after
 *     the fork the copies are the page's own and the write leaves the
 *     source page untouched;
 *   - content only one page renders stays exclusive.
 *
 * Integration tier against a throwaway Postgres (never the dev DB).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const TS = Date.now().toString(36);
const ACTOR = "00000000-0000-0000-0000-00000000ffff";
const SYS: ExecutionContext = { actorId: ACTOR, actorKind: "system", requestId: "excl-sys" };

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let templateId = "";
let cardId = "";
let listId = "";
let pageCount = 0;

async function run(name: string, input: unknown) {
  return execute(registry, adapter, SYS, name, input);
}

async function op<T>(name: string, input: unknown): Promise<T> {
  const r = await run(name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function valuesOf(id: string): Promise<unknown> {
  const db = new SQL(ADMIN_URL as string);
  try {
    const rows = (await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return tx`SELECT "values" FROM content_instances WHERE id = ${id}::uuid`;
    })) as { values: unknown }[];
    return rows[0]?.values;
  } finally {
    await db.end();
  }
}

async function createModule(slug: string, html: string, fields: unknown[]): Promise<string> {
  return (
    await op<{ moduleId: string }>("modules.create", {
      slug: `excl-${slug}-${TS}`,
      displayName: `EXCL ${slug}`,
      html,
      fields,
    })
  ).moduleId;
}

async function instance(moduleId: string, values: unknown): Promise<string> {
  return (
    await op<{ contentInstanceId: string }>("content_instances.create", {
      moduleId,
      displayName: "EXCL instance",
      purpose: "test",
      values,
    })
  ).contentInstanceId;
}

const card = (contentInstanceId: string) => ({ moduleId: cardId, contentInstanceId });
const list = (contentInstanceId: string) => ({ moduleId: listId, contentInstanceId });

/** A page whose one placement binds `root`. */
async function pageWith(root: string, syncMode: "synced" | "unsynced"): Promise<string> {
  pageCount += 1;
  const { pageId } = await op<{ pageId: string }>("pages.create", {
    slug: `excl-page-${pageCount}-${TS}`,
    shortTitle: "Excl",
    title: "Excl",
    templateId,
  });
  await op("pages.set_modules", {
    pageId,
    blocks: [{ blockName: "content", moduleIds: [listId] }],
  });
  await op("placement.set_content", {
    pageId,
    blockName: "content",
    position: 0,
    contentInstanceId: root,
    syncMode,
  });
  return pageId;
}

/** `path → exclusive` of the page's nested content. */
async function exclusiveByPath(pageId: string): Promise<Record<string, boolean>> {
  const listed = await op<{
    placements: { nested: { path: string; exclusive: boolean }[] }[];
  }>("page_module_content.list_for_page", { pageId });
  return Object.fromEntries((listed.placements[0]?.nested ?? []).map((n) => [n.path, n.exclusive]));
}

/** A section (list) holding a row (list) holding a card: three levels. */
async function threeLevels(): Promise<{ root: string; row: string; leaf: string }> {
  const leaf = await instance(cardId, { title: "Kachel" });
  const row = await instance(listId, { items: [card(leaf)] });
  const root = await instance(listId, { items: [list(row)] });
  return { root, row, leaf };
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  const layoutId = (
    await op<{ layoutId: string }>("layouts.create", {
      slug: `excl-layout-${TS}`,
      displayName: "EXCL layout",
      html: `<!doctype html><html><head><title>L</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
      css: "",
      blocks: [{ name: "content", displayName: "Content", position: 0 }],
    })
  ).layoutId;
  templateId = (
    await op<{ templateId: string }>("templates.create", {
      pageType: "home",
      slug: `excl-tpl-${TS}`,
      displayName: "EXCL tpl",
      html: `<!doctype html><html><head><title>T</title></head><body><caelo-slot name="content"></caelo-slot></body></html>`,
      css: "",
      layoutId,
    })
  ).templateId;
  await op("template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  cardId = await createModule("card", "<p>{{title}}</p>", [
    { name: "title", kind: "text", label: "Title" },
  ]);
  listId = await createModule("list", "<ul>{{#items}}{{>.}}{{/items}}</ul>", [
    { name: "items", kind: "module-list", label: "Items" },
  ]);
});

afterAll(async () => {
  await adapter.close();
});

describe("#1309 — nested content is exclusive only when nothing above it is shared", () => {
  it("content only one page renders is that page's own, at every depth", async () => {
    const { root } = await threeLevels();
    const pageId = await pageWith(root, "unsynced");
    expect(await exclusiveByPath(pageId)).toEqual({
      "items[0]": true,
      "items[0]>items[0]": true,
    });
  });

  it("below a root another page binds too, every level is shared", async () => {
    const { root } = await threeLevels();
    await pageWith(root, "synced");
    const variant = await pageWith(root, "synced");
    expect(await exclusiveByPath(variant)).toEqual({
      "items[0]": false,
      "items[0]>items[0]": false,
    });
  });

  it("an own root listing the source's nested content shares the levels below it too; the fork gives the page its own", async () => {
    const source = await threeLevels();
    await pageWith(source.root, "unsynced");
    // The variant's root is its own row, but lists the source's row — a
    // copy made before nested content was deep-copied.
    const variantRoot = await instance(listId, { items: [list(source.row)] });
    const variant = await pageWith(variantRoot, "unsynced");
    expect(await exclusiveByPath(variant)).toEqual({
      "items[0]": false,
      "items[0]>items[0]": false,
    });

    // The second level is refused like the first, with the fork as the way out.
    const refused = await run("page_module_content.set", {
      pageId: variant,
      blockName: "content",
      position: 0,
      nestedPath: "items[0]>items[0]",
      contentValues: { title: "Tile" },
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    const error = refused.error as { message: string; nextAction?: { tool: string } };
    expect(error.message).toContain("shared with another page");
    expect(error.nextAction?.tool).toBe("fork_placement_content");

    await op("placement.fork_content", { pageId: variant, blockName: "content", position: 0 });
    expect(await exclusiveByPath(variant)).toEqual({
      "items[0]": true,
      "items[0]>items[0]": true,
    });
    await op("page_module_content.set", {
      pageId: variant,
      blockName: "content",
      position: 0,
      nestedPath: "items[0]>items[0]",
      contentValues: { title: "Tile" },
    });
    // The source page still renders its own text.
    expect(await valuesOf(source.leaf)).toEqual({ title: "Kachel" });
  });
});
