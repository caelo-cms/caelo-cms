// SPDX-License-Identifier: MPL-2.0

/**
 * #1453 — updating a translation keeps content instances shared between
 * pages of the target language.
 *
 * The site from the report: the German comparison pages show tool data
 * from German instances; their English versions share `tool-peec-en` and
 * `tool-profound-en`, each rendering on two English pages. An update pass
 * that changes one text of Peec must land in `tool-peec-en`. It used to
 * fork the placement, which replaced the page's whole nested tree with
 * private copies: both shared instances dropped to zero pages, also
 * Profound, whose text nobody touched.
 *
 * Integration tier against a throwaway Postgres (never the dev DB), through
 * the plugin's real operations and core's real ops; only the model is
 * replaced by the agent's answer to the work item.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  bootstrap,
  pluginWorkerScheduler,
  resetPluginHost,
  runPluginOperation,
} from "@caelo-cms/plugin-host";
import intlPlugin from "@caelo-cms/plugin-international-site";
import type { AiWorkItem } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const TAG = "t1453";
const ACTOR = "00000000-0000-0000-0000-00000000ffff";
const SYS: ExecutionContext = { actorId: ACTOR, actorKind: "system", requestId: TAG };

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let templateId = "";
let listModule = "";
let cardModule = "";
let toolModule = "";
let pageCount = 0;

async function sqlSystem<T>(fn: (tx: Bun.SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as Bun.SQL);
    });
  } finally {
    await sql.end();
  }
}

async function plugin<T>(operationName: string, args: unknown, aiDelegated = true): Promise<T> {
  const r = await runPluginOperation({
    invocation: { origin: "system", actorId: "00000000-0000-0000-0000-000000000000", aiDelegated },
    pluginSlug: "international-site",
    operationName,
    args,
  });
  if (!r.ok) throw new Error(`${operationName}: ${r.error.kind}: ${r.error.message}`);
  return r.value as T;
}

async function core<T>(name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, SYS, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function cleanup(): Promise<void> {
  resetPluginHost();
  await sqlSystem(async (tx) => {
    await tx.unsafe('DROP SCHEMA IF EXISTS "plugin_international_site" CASCADE');
    await tx.unsafe(`DELETE FROM redirects WHERE from_path LIKE '%${TAG}%'`);
    await tx.unsafe("DELETE FROM plugins WHERE slug = 'international-site'");
    await tx.unsafe(`DELETE FROM pages WHERE slug LIKE '${TAG}-%'`);
    await tx.unsafe(
      `DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE slug LIKE '${TAG}-%')`,
    );
    await tx.unsafe(`DELETE FROM modules WHERE slug LIKE '${TAG}-%'`);
    await tx.unsafe(`DELETE FROM templates WHERE slug LIKE '${TAG}-%'`);
    await tx.unsafe(`DELETE FROM layouts WHERE slug LIKE '${TAG}-%'`);
  });
}

async function instance(moduleId: string, values: Record<string, unknown>): Promise<string> {
  return (
    await core<{ contentInstanceId: string }>("content_instances.create", {
      moduleId,
      displayName: `${TAG} instance`,
      purpose: "test",
      values,
    })
  ).contentInstanceId;
}

/** A card showing `tool` next to its own note. */
const cardOf = (note: string, tool: string) =>
  instance(cardModule, {
    card_note: note,
    tool: { moduleId: toolModule, contentInstanceId: tool },
  });

/** A list of `cards`, ready to be placed. */
const listOf = (cards: readonly string[]) =>
  instance(listModule, {
    items: cards.map((contentInstanceId) => ({ moduleId: cardModule, contentInstanceId })),
  });

/** A page whose only placement (content #0) binds `root`. */
async function pageWith(root: string, syncMode: "synced" | "unsynced" = "unsynced") {
  pageCount += 1;
  const { pageId } = await core<{ pageId: string }>("pages.create", {
    slug: `${TAG}-${pageCount}`,
    title: `Page ${pageCount}`,
    templateId,
  });
  await core("pages.set_modules", {
    pageId,
    blocks: [{ blockName: "content", moduleIds: [listModule] }],
  });
  await core("placement.set_content", {
    pageId,
    blockName: "content",
    position: 0,
    contentInstanceId: root,
    syncMode,
  });
  return pageId;
}

/** `page` becomes the English version of `source`. */
async function linkEnglish(source: string, page: string): Promise<void> {
  await plugin("link_page_variants", {
    pageId: page,
    groupPageId: source,
    localeCode: "en",
  });
}

interface ApplyOutcome {
  applied: number;
  failed: number;
  results: { slotsApplied?: number }[];
}

interface NestedRead {
  path: string;
  contentInstanceId: string;
  values: Record<string, unknown>;
}

async function readPage(pageId: string): Promise<{ root: string; nested: NestedRead[] }> {
  const { placements } = await core<{
    placements: { contentInstanceId: string; nested: NestedRead[] }[];
  }>("page_module_content.list_for_page", { pageId });
  const placement = placements[0];
  if (!placement) throw new Error(`page ${pageId} has no placement`);
  return { root: placement.contentInstanceId, nested: placement.nested };
}

/** path → instance id of a page's nested content. */
const idsOf = (read: { nested: NestedRead[] }) =>
  Object.fromEntries(read.nested.map((n) => [n.path, n.contentInstanceId]));

async function valuesOf(id: string): Promise<Record<string, unknown> | undefined> {
  const rows = await sqlSystem(
    async (tx) =>
      (await tx.unsafe(`SELECT "values" AS values FROM content_instances WHERE id = '${id}'`)) as {
        values: Record<string, unknown>;
      }[],
  );
  return rows[0]?.values;
}

/**
 * Run an update pass the way the Power-MCP agent does: take the work item,
 * answer it (slot id → field → text) and apply the answer.
 */
async function applyUpdate(
  variantPageId: string,
  answer: (slotIdOf: (needle: string) => string) => Record<string, Record<string, string>>,
): Promise<ApplyOutcome> {
  const { workItem } = await plugin<{ workItem: AiWorkItem }>("translate_variant", {
    variantPageId,
    mode: "update",
  });
  // The prompt names every slot: `### Slot s3 (module …, nested at …)`,
  // followed by its fields. Finding a slot by a text it shows is exactly
  // what an agent does with the prompt.
  const user = workItem.instructions.user;
  const sourcePart = user.split("## Existing translation")[0] as string;
  const slotIdOf = (needle: string): string => {
    const at = sourcePart.indexOf(needle);
    if (at === -1) throw new Error(`no slot shows "${needle}"`);
    const headings = [...sourcePart.slice(0, at).matchAll(/### Slot (\S+) /g)];
    const id = headings.at(-1)?.[1];
    if (!id) throw new Error(`no slot heading before "${needle}"`);
    return id;
  };
  const slots = Object.entries(answer(slotIdOf)).map(([slot, values]) => ({
    slot,
    values: Object.entries(values).map(([field, value]) => ({ field, value })),
  }));
  const item = (workItem.apply.args as { items: Record<string, unknown>[] }).items[0];
  const out = await plugin<ApplyOutcome>("apply_translations", {
    items: [{ ...item, result: { title: null, shortTitle: null, slots } }],
  });
  if (out.failed > 0) throw new Error(`apply_translations failed: ${JSON.stringify(out.results)}`);
  return out;
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await cleanup();
  const report = await bootstrap({
    infra: { adapter, registry },
    pluginsRoot: "/dev/null/unused",
    systemActorId: ACTOR,
    testPlugins: [{ definition: intlPlugin }],
  });
  if (report.failed.length > 0) throw new Error(JSON.stringify(report.failed));
  pluginWorkerScheduler.pausePlugin("international-site");
  await plugin(
    "set_locales",
    {
      locales: [
        { code: "de", displayName: "Deutsch", urlStrategy: "none", isDefault: true },
        { code: "en", displayName: "English", urlStrategy: "subdirectory", isDefault: false },
        { code: "fr", displayName: "Français", urlStrategy: "subdirectory", isDefault: false },
      ],
    },
    false,
  );
  const { layoutId } = await core<{ layoutId: string }>("layouts.create", {
    slug: `${TAG}-lay`,
    displayName: "L",
    html: `<!doctype html><html><head><title>L</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
    css: "",
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  templateId = (
    await core<{ templateId: string }>("templates.create", {
      pageType: "home",
      slug: `${TAG}-tpl`,
      displayName: "T",
      html: `<!doctype html><html><head><title>T</title></head><body><caelo-slot name="content"></caelo-slot></body></html>`,
      css: "",
      layoutId,
    })
  ).templateId;
  await core("template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  const moduleOf = async (slug: string, html: string, fields: unknown[]) =>
    (
      await core<{ moduleId: string }>("modules.create", {
        slug: `${TAG}-${slug}`,
        displayName: slug,
        html,
        fields,
      })
    ).moduleId;
  toolModule = await moduleOf("tool", "<dl><dt>{{limits}}</dt><dd>{{updated}}</dd></dl>", [
    { name: "limits", kind: "text", label: "Limits" },
    { name: "updated", kind: "text", label: "Updated" },
  ]);
  cardModule = await moduleOf("card", "<article><p>{{card_note}}</p>{{>tool}}</article>", [
    { name: "card_note", kind: "text", label: "Note" },
    { name: "tool", kind: "module", label: "Tool" },
  ]);
  listModule = await moduleOf("list", "<div>{{#items}}{{>.}}{{/items}}</div>", [
    { name: "items", kind: "module-list", label: "Items" },
  ]);
});

afterAll(async () => {
  await cleanup();
  await adapter.close();
});

/**
 * Two German pages, each with its English version. Both German pages show
 * the German tool data, both English pages the English tool data: the
 * trees differ per language, the tools are shared inside each language.
 */
async function comparisonPages() {
  const peecDe = await instance(toolModule, { limits: "Grenzen Peec", updated: "Stand 1" });
  const profoundDe = await instance(toolModule, { limits: "Grenzen Profound", updated: "Stand 2" });
  const peecEn = await instance(toolModule, { limits: "Peec limits", updated: "As of 1" });
  const profoundEn = await instance(toolModule, { limits: "Profound limits", updated: "As of 2" });
  const german = async (noteA: string, noteB: string) =>
    pageWith(await listOf([await cardOf(noteA, peecDe), await cardOf(noteB, profoundDe)]));
  const english = async (noteA: string, noteB: string) =>
    pageWith(await listOf([await cardOf(noteA, peecEn), await cardOf(noteB, profoundEn)]));
  const de1 = await german("Notiz A1", "Notiz B1");
  const de2 = await german("Notiz A2", "Notiz B2");
  const en1 = await english("Note A1", "Note B1");
  const en2 = await english("Note A2", "Note B2");
  await linkEnglish(de1, en1);
  await linkEnglish(de2, en2);
  return { peecDe, profoundDe, peecEn, profoundEn, de1, de2, en1, en2 };
}

describe("#1453 — a translation update keeps shared instances of the target language", () => {
  it("writes a changed text into the instance the English pages share, and replaces nothing", async () => {
    const site = await comparisonPages();
    const before = await readPage(site.en1);
    const otherPage = await readPage(site.en2);

    const applied = await applyUpdate(site.en1, (slot) => ({
      [slot("Grenzen Peec")]: { limits: "New Peec limits" },
    }));
    expect(applied).toMatchObject({ applied: 1, failed: 0 });
    expect(applied.results[0]?.slotsApplied).toBe(1);

    // Every instance id of the page is the one it had: nothing was copied.
    const after = await readPage(site.en1);
    expect(after.root).toBe(before.root);
    expect(idsOf(after)).toEqual(idsOf(before));
    expect(idsOf(after)["items[0]>tool"]).toBe(site.peecEn);
    expect(idsOf(after)["items[1]>tool"]).toBe(site.profoundEn);

    // The text is in the shared row, so the other English page shows it too.
    expect(await valuesOf(site.peecEn)).toEqual({ limits: "New Peec limits", updated: "As of 1" });
    expect(await valuesOf(site.profoundEn)).toEqual({
      limits: "Profound limits",
      updated: "As of 2",
    });
    expect(idsOf(await readPage(site.en2))).toEqual(idsOf(otherPage));
    const reach = await core<{ renderedOn: { pageId: string }[] }>("content_instances.get", {
      id: site.peecEn,
    });
    expect(reach.renderedOn.map((p) => p.pageId).sort()).toEqual([site.en1, site.en2].sort());

    // The German side is untouched.
    expect(await valuesOf(site.peecDe)).toEqual({ limits: "Grenzen Peec", updated: "Stand 1" });
  }, 60_000);

  it("copies an instance shared with the source language, and nothing else of the tree", async () => {
    const site = await comparisonPages();
    // The English page's first card still shows the German tool.
    const before = await readPage(site.en1);
    const firstCard = idsOf(before)["items[0]"] as string;
    await core("content_instances.set_values", {
      id: firstCard,
      values: {
        card_note: "Note A1",
        tool: { moduleId: toolModule, contentInstanceId: site.peecDe },
      },
    });

    await applyUpdate(site.en1, (slot) => ({
      [slot("Grenzen Peec")]: { limits: "Peec limits (new)" },
    }));

    const after = await readPage(site.en1);
    const ids = idsOf(after);
    // Only the tool got a copy: the card keeps its id and points at it, the
    // sibling card and its shared tool are as they were.
    expect(after.root).toBe(before.root);
    expect(ids["items[0]"]).toBe(firstCard);
    expect(ids["items[0]>tool"]).not.toBe(site.peecDe);
    expect(ids["items[1]"]).toBe(idsOf(before)["items[1]"] as string);
    expect(ids["items[1]>tool"]).toBe(site.profoundEn);
    expect(await valuesOf(ids["items[0]>tool"] as string)).toEqual({
      limits: "Peec limits (new)",
      updated: "Stand 1",
    });
    // The German pages keep their text and their instance.
    expect(await valuesOf(site.peecDe)).toEqual({ limits: "Grenzen Peec", updated: "Stand 1" });
    expect(idsOf(await readPage(site.de1))["items[0]>tool"]).toBe(site.peecDe);
  }, 60_000);

  it("copies a whole chain whose upper levels the source language shares, and leaves its unchanged neighbours", async () => {
    const peecDe = await instance(toolModule, { limits: "Grenzen Peec", updated: "Stand 1" });
    const profoundDe = await instance(toolModule, {
      limits: "Grenzen Profound",
      updated: "Stand 2",
    });
    const card = await cardOf("Notiz A", peecDe);
    const otherCard = await cardOf("Notiz B", profoundDe);
    const root = await listOf([card, otherCard]);
    // Both language versions are bound to one and the same tree.
    const de = await pageWith(root, "synced");
    const en = await pageWith(root, "synced");
    await linkEnglish(de, en);

    await applyUpdate(en, (slot) => ({ [slot("Grenzen Peec")]: { limits: "Peec limits" } }));

    const after = await readPage(en);
    const ids = idsOf(after);
    expect(after.root).not.toBe(root);
    expect(ids["items[0]"]).not.toBe(card);
    expect(ids["items[0]>tool"]).not.toBe(peecDe);
    // Nobody answered the second card: it stays what it was.
    expect(ids["items[1]"]).toBe(otherCard);
    expect(ids["items[1]>tool"]).toBe(profoundDe);
    expect(await valuesOf(ids["items[0]>tool"] as string)).toMatchObject({ limits: "Peec limits" });
    // The source page renders exactly what it did.
    const source = await readPage(de);
    expect(source.root).toBe(root);
    expect(idsOf(source)["items[0]>tool"]).toBe(peecDe);
    expect(await valuesOf(peecDe)).toEqual({ limits: "Grenzen Peec", updated: "Stand 1" });
  }, 60_000);

  it("treats another translated language like the source: its instance is copied", async () => {
    const site = await comparisonPages();
    const french = await pageWith(await listOf([await cardOf("Note FR", site.peecEn)]));
    await plugin("link_page_variants", {
      pageId: french,
      groupPageId: site.de1,
      localeCode: "fr",
    });

    await applyUpdate(site.en1, (slot) => ({
      [slot("Grenzen Peec")]: { limits: "New Peec limits" },
    }));

    const ids = idsOf(await readPage(site.en1));
    expect(ids["items[0]>tool"]).not.toBe(site.peecEn);
    expect(await valuesOf(site.peecEn)).toEqual({ limits: "Peec limits", updated: "As of 1" });
  }, 60_000);

  it("writes through a placement synced to an instance only English pages use", async () => {
    const tool = await instance(toolModule, { limits: "Shared limits", updated: "As of 1" });
    const root = await listOf([await cardOf("Shared note", tool)]);
    const enA = await pageWith(root, "synced");
    const enB = await pageWith(root, "synced");
    const german = async () =>
      pageWith(
        await listOf([
          await cardOf(
            "Geteilte Notiz",
            await instance(toolModule, { limits: "Geteilte Grenzen", updated: "Stand 1" }),
          ),
        ]),
      );
    await linkEnglish(await german(), enA);
    await linkEnglish(await german(), enB);

    await applyUpdate(enA, (slot) => ({
      [slot("Geteilte Grenzen")]: { limits: "New shared limits" },
    }));

    expect((await readPage(enA)).root).toBe(root);
    expect((await readPage(enB)).root).toBe(root);
    expect(await valuesOf(tool)).toMatchObject({ limits: "New shared limits" });
  }, 60_000);

  it("an answer that repeats the current text changes nothing", async () => {
    const site = await comparisonPages();
    const before = await readPage(site.en1);
    const peecVersion = async () => {
      const got = await core<{ instance: { version: number } }>("content_instances.get", {
        id: site.peecDe,
      });
      return got.instance.version;
    };
    const version = await peecVersion();
    await applyUpdate(site.en1, (slot) => ({
      [slot("Grenzen Peec")]: { limits: "Peec limits" },
    }));
    const after = await readPage(site.en1);
    expect(after.root).toBe(before.root);
    expect(idsOf(after)).toEqual(idsOf(before));
    expect(await peecVersion()).toBe(version);
  }, 60_000);

  it("core refuses an in-place write that reaches a page the caller did not name", async () => {
    const site = await comparisonPages();
    const at = { pageId: site.en1, blockName: "content", position: 0 };
    const writeTool = core("page_module_content.set", {
      ...at,
      nestedPath: "items[0]>tool",
      contentValues: { limits: "Nope", updated: "As of 1" },
      alsoChangesPages: [],
    });
    await expect(writeTool).rejects.toThrow("also renders on");
    expect(await valuesOf(site.peecEn)).toMatchObject({ limits: "Peec limits" });

    // Copying the tool rewrites its card, which is this page's alone; the
    // list above stays. Asking to copy nothing of a shared parent's chain
    // is refused the same way once the parent renders elsewhere.
    const shared = await instance(cardModule, {
      card_note: "Shared card",
      tool: { moduleId: toolModule, contentInstanceId: site.peecDe },
    });
    const root = await listOf([shared]);
    const onOtherPage = await pageWith(await listOf([shared]));
    const page = await pageWith(root);
    const before = await valuesOf(shared);
    const fork = core("placement.fork_paths", {
      pageId: page,
      blockName: "content",
      position: 0,
      root: false,
      nestedPaths: ["items[0]>tool"],
      alsoChangesPages: [],
    });
    await expect(fork).rejects.toThrow("also renders on");
    expect(await valuesOf(shared)).toEqual(before as Record<string, unknown>);
    const named = await core<{ copied: number }>("placement.fork_paths", {
      pageId: page,
      blockName: "content",
      position: 0,
      root: false,
      nestedPaths: ["items[0]>tool"],
      alsoChangesPages: [onOtherPage],
    });
    expect(named.copied).toBe(1);
    // The other page sees the copy through the card it shares, as declared.
    expect(idsOf(await readPage(onOtherPage))["items[0]>tool"]).not.toBe(site.peecDe);
  }, 60_000);

  it("placement.fork_paths names a path that does not exist instead of guessing", async () => {
    const page = await pageWith(await listOf([]));
    const fork = core("placement.fork_paths", {
      pageId: page,
      blockName: "content",
      position: 0,
      root: false,
      nestedPaths: ["items[3]"],
      alsoChangesPages: [],
    });
    await expect(fork).rejects.toThrow("no nested content at");
  }, 60_000);

  it("a fork on a chat branch stays on the branch", async () => {
    const tool = await instance(toolModule, { limits: "Geteilt", updated: "Stand 1" });
    const root = await listOf([await cardOf("Notiz", tool)]);
    const de = await pageWith(root);
    const en = await pageWith(root);
    await linkEnglish(de, en);
    const chat = await core<{ chatSessionId: string; chatBranchId: string }>(
      "chat.create_session",
      { title: `${TAG} branch` },
    );
    const ctx: ExecutionContext = {
      ...SYS,
      chatBranchId: chat.chatBranchId,
      chatTaskId: chat.chatSessionId,
    };
    const run = await execute(registry, adapter, ctx, "placement.fork_paths", {
      pageId: en,
      blockName: "content",
      position: 0,
      root: true,
      nestedPaths: ["items[0]", "items[0]>tool"],
      alsoChangesPages: [],
    });
    if (!run.ok) throw new Error(JSON.stringify(run.error));
    const onBranch = await execute(registry, adapter, ctx, "page_module_content.list_for_page", {
      pageId: en,
    });
    if (!onBranch.ok) throw new Error(JSON.stringify(onBranch.error));
    const placement = (
      onBranch.value as {
        placements: { contentInstanceId: string; nested: NestedRead[] }[];
      }
    ).placements[0];
    expect(placement?.contentInstanceId).toBe(
      (run.value as { contentInstanceId: string }).contentInstanceId,
    );
    expect(placement?.nested.find((n) => n.path === "items[0]>tool")?.contentInstanceId).not.toBe(
      tool,
    );
    // Main still shows what it showed.
    const live = await readPage(en);
    expect(live.root).toBe(root);
    expect(idsOf(live)["items[0]>tool"]).toBe(tool);
  }, 60_000);

  it("two slots showing one instance both land in it", async () => {
    const tool = await instance(toolModule, { limits: "Limits", updated: "As of 1" });
    const de = await pageWith(
      await listOf([
        await cardOf(
          "Notiz A",
          await instance(toolModule, { limits: "Erste", updated: "Stand A" }),
        ),
        await cardOf(
          "Notiz B",
          await instance(toolModule, { limits: "Zweite", updated: "Stand B" }),
        ),
      ]),
    );
    const en = await pageWith(
      await listOf([await cardOf("Note A", tool), await cardOf("Note B", tool)]),
    );
    await linkEnglish(de, en);

    await applyUpdate(en, (slot) => ({
      [slot("Erste")]: { limits: "New limits" },
      [slot("Zweite")]: { updated: "New date" },
    }));

    expect(await valuesOf(tool)).toEqual({ limits: "New limits", updated: "New date" });
  }, 60_000);

  it("copying one of two references to an instance leaves the other", async () => {
    const shared = await cardOf(
      "Notiz A",
      await instance(toolModule, { limits: "Grenzen", updated: "Stand 1" }),
    );
    const de = await pageWith(
      await listOf([
        shared,
        await cardOf("Notiz B", await instance(toolModule, { limits: "B", updated: "Stand 2" })),
      ]),
    );
    const en = await pageWith(await listOf([shared, shared]));
    await linkEnglish(de, en);

    await applyUpdate(en, (slot) => ({ [slot("Notiz A")]: { card_note: "Note A" } }));

    const ids = idsOf(await readPage(en));
    expect(ids["items[0]"]).not.toBe(shared);
    expect(ids["items[1]"]).toBe(shared);
    expect(await valuesOf(shared)).toMatchObject({ card_note: "Notiz A" });
    expect(await valuesOf(ids["items[0]"] as string)).toMatchObject({ card_note: "Note A" });
  }, 60_000);

  it("a refused parent rewrite rolls the whole fork back", async () => {
    const tool = await instance(toolModule, { limits: "Grenzen", updated: "Stand 1" });
    const card = await cardOf("Notiz", tool);
    const page = await pageWith(await listOf([card]));
    const chat = await core<{ chatSessionId: string; chatBranchId: string }>(
      "chat.create_session",
      { title: `${TAG} experiment`, isolation: "experiment" },
    );
    // A sibling task on the branch holds the card.
    const holder: ExecutionContext = {
      ...SYS,
      chatBranchId: chat.chatBranchId,
      chatTaskId: chat.chatSessionId,
    };
    const held = await execute(registry, adapter, holder, "content_instances.set_values", {
      id: card,
      values: await valuesOf(card),
    });
    if (!held.ok) throw new Error(JSON.stringify(held.error));
    const countInstances = () =>
      sqlSystem(async (tx) => {
        const rows = (await tx.unsafe(
          `SELECT count(*)::int AS n FROM content_instances WHERE module_id = '${toolModule}'`,
        )) as { n: number }[];
        return rows[0]?.n;
      });
    const before = await countInstances();

    const refused = await execute(
      registry,
      adapter,
      { ...holder, chatTaskId: crypto.randomUUID() },
      "placement.fork_paths",
      {
        pageId: page,
        blockName: "content",
        position: 0,
        root: false,
        nestedPaths: ["items[0]>tool"],
        alsoChangesPages: [],
      },
    );

    expect(refused.ok).toBe(false);
    expect(await countInstances()).toBe(before);
  }, 60_000);
});
