// SPDX-License-Identifier: MPL-2.0

/**
 * #1287 — what content-instance values reference is indexed
 * (`content_instance_refs`, migration 0458), not found by scanning every
 * instance's values as text.
 *
 *   - The triggers keep the index exact on insert, a values update, an
 *     update that leaves the values alone, and a hard delete; the rebuild
 *     op reports drift and repairs it.
 *   - Each needle kind finds what the old substring scan found: a nested
 *     instance id, a module id, a list id (`caelo:list/<id>`), a media id
 *     (`caelo:media/<id>` and the legacy `/_caelo/media/<id>/<variant>`),
 *     a media slug matched whole (`hero` is not found in `hero-dark`), an
 *     id stored in upper case.
 *   - The live lookup is served by the index: on a few thousand instances
 *     the plan scans neither `content_instances` nor the refs table.
 *   - `page_module_content.list_for_page` (international-site's
 *     translator, whose activation the old scan broke) still tells a
 *     nested child that only this page renders from one shared elsewhere.
 *
 * Integration tier against a throwaway Postgres (never the dev DB).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { observeDraftReads } from "../locks.js";
import {
  type ContentInstanceNeedle,
  contentInstanceRefsDrift,
  findContentInstancesContaining,
  idNeedles,
  liveInstancesSql,
  needleFilterSql,
} from "../ops/content/content-instance-refs.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const TS = Date.now().toString(36);
const ACTOR = "00000000-0000-0000-0000-00000000ffff";
const SYS: ExecutionContext = { actorId: ACTOR, actorKind: "system", requestId: "cirefs-sys" };

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let templateId = "";
let cardId = "";
let listModuleId = "";

async function op<T>(name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, SYS, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function asSystem<T>(fn: (tx: Bun.SQL) => Promise<T>): Promise<T> {
  const db = new SQL(ADMIN_URL as string);
  try {
    return (await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as Bun.SQL);
    })) as T;
  } finally {
    await db.end();
  }
}

async function createModule(slug: string, html: string, fields: unknown[]): Promise<string> {
  return (
    await op<{ moduleId: string }>("modules.create", {
      slug: `cirefs-${slug}-${TS}`,
      displayName: `CIREFS ${slug}`,
      html,
      fields,
    })
  ).moduleId;
}

async function instance(moduleId: string, values: unknown): Promise<string> {
  return (
    await op<{ contentInstanceId: string }>("content_instances.create", {
      moduleId,
      displayName: "CIREFS instance",
      purpose: "test",
      values,
    })
  ).contentInstanceId;
}

/**
 * An instance written straight into the table: values the write ops refuse
 * (a media URL with no asset behind it, an upper-case module id) still go
 * through the triggers.
 */
async function rawInstance(moduleId: string, values: unknown): Promise<string> {
  const rows = await asSystem(
    (tx) =>
      tx`INSERT INTO content_instances (module_id, "values")
         VALUES (${moduleId}::uuid, (${JSON.stringify(values)}::text)::jsonb)
         RETURNING id::text AS id` as Promise<{ id: string }[]>,
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("raw instance insert returned no id");
  return id;
}

/** The indexed references of one instance, as `kind=ref` strings. */
async function refsOf(contentInstanceId: string): Promise<string[]> {
  const rows = await asSystem(
    (tx) =>
      tx`SELECT ref_kind || '=' || ref AS r FROM content_instance_refs
          WHERE content_instance_id = ${contentInstanceId}::uuid ORDER BY 1` as Promise<
        { r: string }[]
      >,
  );
  return rows.map((x) => x.r);
}

async function found(needles: ContentInstanceNeedle[]): Promise<string[]> {
  const refs = await adapter.withAdminTransaction(SYS, (tx) =>
    findContentInstancesContaining(tx, null, needles),
  );
  return refs.map((r) => r.contentInstanceId).sort();
}

const ref = (contentInstanceId: string, moduleId = cardId) => ({ moduleId, contentInstanceId });

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  const layoutId = (
    await op<{ layoutId: string }>("layouts.create", {
      slug: `cirefs-layout-${TS}`,
      displayName: "CIREFS layout",
      html: `<!doctype html><html><head><title>L</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
      css: "",
      blocks: [{ name: "content", displayName: "Content", position: 0 }],
    })
  ).layoutId;
  templateId = (
    await op<{ templateId: string }>("templates.create", {
      pageType: "home",
      slug: `cirefs-tpl-${TS}`,
      displayName: "CIREFS tpl",
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
  listModuleId = await createModule("list", "<ul>{{#items}}{{>.}}{{/items}}</ul>", [
    { name: "items", kind: "module-list", label: "Items" },
  ]);
});

afterAll(async () => {
  await adapter.close();
});

describe("#1287 — the reference index stays exact", () => {
  it("follows inserts, value updates, other updates and deletes", async () => {
    const child = await instance(cardId, { title: "Child" });
    const parent = await instance(listModuleId, { items: [ref(child)] });
    expect(await refsOf(parent)).toEqual([`id=${cardId}`, `id=${child}`].sort());
    expect(await refsOf(child)).toEqual([]);

    // A values update re-indexes; an update of another column leaves it.
    const other = await instance(cardId, { title: "Other" });
    await op("content_instances.set_values", { id: parent, values: { items: [ref(other)] } });
    expect(await refsOf(parent)).toEqual([`id=${cardId}`, `id=${other}`].sort());
    await asSystem(
      (tx) => tx`UPDATE content_instances SET display_name = 'Renamed' WHERE id = ${parent}::uuid`,
    );
    expect(await refsOf(parent)).toEqual([`id=${cardId}`, `id=${other}`].sort());

    // A hard delete takes the rows with it.
    await asSystem((tx) => tx`DELETE FROM content_instances WHERE id = ${parent}::uuid`);
    expect(await refsOf(parent)).toEqual([]);

    expect(await adapter.withAdminTransaction(SYS, (tx) => contentInstanceRefsDrift(tx))).toEqual({
      missing: 0,
      extra: 0,
    });
  });

  it("the rebuild reports drift and repairs it", async () => {
    const child = await instance(cardId, { title: "Rebuilt child" });
    const parent = await instance(listModuleId, { items: [ref(child)] });
    await asSystem(
      (tx) => tx`DELETE FROM content_instance_refs WHERE content_instance_id = ${parent}::uuid`,
    );
    const r = await op<{ rows: number; drift: { missing: number; extra: number } }>(
      "content_instances.rebuild_refs",
      {},
    );
    expect(r.drift.missing).toBe(2);
    expect(r.drift.extra).toBe(0);
    expect(r.rows).toBeGreaterThanOrEqual(2);
    expect(await refsOf(parent)).toEqual([`id=${cardId}`, `id=${child}`].sort());
  });

  it("the rebuild is system-only", async () => {
    const human: ExecutionContext = { actorId: ACTOR, actorKind: "human", requestId: "cirefs-h" };
    const r = await execute(registry, adapter, human, "content_instances.rebuild_refs", {});
    expect(r.ok).toBe(false);
  });
});

describe("#1287 — every needle kind finds what the substring scan found", () => {
  it("a nested instance id and its module id", async () => {
    const child = await instance(cardId, { title: "Nested" });
    const parent = await instance(listModuleId, { items: [ref(child)] });
    expect(await found([{ kind: "id", id: child }])).toEqual([parent]);
    expect(await found([{ kind: "id", id: cardId }])).toContain(parent);
  });

  it("a list id in a `caelo:list/<id>` binding", async () => {
    const listId = crypto.randomUUID();
    const bound = await instance(cardId, { title: `caelo:list/${listId}` });
    expect(await found([{ kind: "id", id: listId }])).toEqual([bound]);
  });

  it("a media id in both id forms, and a slug only as a whole", async () => {
    const assetId = crypto.randomUUID();
    const stored = await rawInstance(cardId, { title: `caelo:media/${assetId}` });
    const legacy = await rawInstance(cardId, { title: `/_caelo/media/${assetId}/thumb` });
    expect(await found([{ kind: "id", id: assetId }])).toEqual([stored, legacy].sort());

    const slug = `cirefs-hero-${TS}`;
    const exact = await rawInstance(cardId, { title: `<img src="/_caelo/media/${slug}">` });
    await rawInstance(cardId, { title: `<img src="/_caelo/media/${slug}-dark">` });
    expect(await found([{ kind: "media_slug", slug }])).toEqual([exact]);
  });

  it("an id stored in upper case", async () => {
    const child = await instance(cardId, { title: "Upper" });
    const parent = await rawInstance(listModuleId, {
      items: [{ moduleId: cardId.toUpperCase(), contentInstanceId: child.toUpperCase() }],
    });
    expect(await found([{ kind: "id", id: child }])).toEqual([parent]);
  });

  it("a soft-deleted instance is not found", async () => {
    const child = await instance(cardId, { title: "Gone parent's child" });
    const parent = await instance(listModuleId, { items: [ref(child)] });
    await asSystem(
      (tx) => tx`UPDATE content_instances SET deleted_at = now() WHERE id = ${parent}::uuid`,
    );
    expect(await found([{ kind: "id", id: child }])).toEqual([]);
  });
});

describe("#1287 — the lookup is served by the index", () => {
  it("scans neither content_instances nor the refs table on a few thousand instances", async () => {
    await asSystem(async (tx) => {
      await tx.unsafe(`
        INSERT INTO content_instances (module_id, "values")
        SELECT '${listModuleId}',
               jsonb_build_object('items', jsonb_build_array(jsonb_build_object(
                 'moduleId', '${cardId}', 'contentInstanceId', gen_random_uuid()::text)),
                 'body', repeat('<p>copy</p>', 50))
          FROM generate_series(1, 5000)`);
      await tx.unsafe("ANALYZE content_instances");
      await tx.unsafe("ANALYZE content_instance_refs");
    });
    const needle = crypto.randomUUID();
    const plan = await adapter.withAdminTransaction(SYS, async (tx) => {
      const rows = (await tx.execute(
        sql`EXPLAIN (FORMAT JSON) ${liveInstancesSql(null, needleFilterSql([{ kind: "id", id: needle }]))}`,
      )) as unknown as Record<string, unknown>[];
      return JSON.stringify(rows);
    });
    expect(plan).toContain("content_instance_refs_ref_idx");
    const seqScans = [...plan.matchAll(/"Node Type":"Seq Scan"[^}]*?"Relation Name":"(\w+)"/g)].map(
      (m) => m[1],
    );
    expect(seqScans).not.toContain("content_instances");
    expect(seqScans).not.toContain("content_instance_refs");
  });
});

describe("#1287 — list_for_page reads its nested tree through the index", () => {
  it("tells a child only this page renders from one shared with another parent", async () => {
    const own = await instance(cardId, { title: "Only here" });
    const shared = await instance(cardId, { title: "Shared" });
    const root = await instance(listModuleId, { items: [ref(own), ref(shared)] });
    await instance(listModuleId, { items: [ref(shared)] });
    const { pageId } = await op<{ pageId: string }>("pages.create", {
      slug: `cirefs-page-${TS}`,
      shortTitle: "Refs",
      title: "Refs",
      templateId,
    });
    await op("pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [listModuleId] }],
    });
    await op("placement.set_content", {
      pageId,
      blockName: "content",
      position: 0,
      contentInstanceId: root,
      syncMode: "synced",
    });
    const listed = await op<{
      placements: { nested: { contentInstanceId: string; exclusive: boolean }[] }[];
    }>("page_module_content.list_for_page", { pageId });
    const nested = new Map(
      (listed.placements[0]?.nested ?? []).map((n) => [n.contentInstanceId, n.exclusive]),
    );
    expect(nested.get(own)).toBe(true);
    expect(nested.get(shared)).toBe(false);
  });
});

describe("#1390 — a branch's pending states come from the draft head", () => {
  async function draftChat(title: string): Promise<ExecutionContext> {
    const v = await op<{ chatSessionId: string; chatBranchId: string }>("chat.create_session", {
      title: `cirefs-${title}-${TS}`,
    });
    return {
      actorId: ACTOR,
      actorKind: "ai",
      requestId: `cirefs-${title}`,
      chatBranchId: v.chatBranchId,
      chatTaskId: v.chatSessionId,
    };
  }
  async function foundIn(ctx: ExecutionContext, needles: ContentInstanceNeedle[]) {
    const refs = await adapter.withAdminTransaction(ctx, (tx) =>
      findContentInstancesContaining(tx, ctx.chatBranchId ?? null, needles),
    );
    return refs.map((r) => r.contentInstanceId).sort();
  }
  async function setValues(ctx: ExecutionContext, id: string, values: unknown): Promise<void> {
    const r = await execute(registry, adapter, ctx, "content_instances.set_values", { id, values });
    if (!r.ok) throw new Error(`set_values: ${JSON.stringify(r.error)}`);
  }

  it("the newest pending state decides, even when an older one matched", async () => {
    const child = await instance(cardId, { title: "Head child" });
    const other = await instance(cardId, { title: "Head other" });
    const parent = await instance(listModuleId, { items: [ref(other)] });
    const chat = await draftChat("head");

    // Pending: first the parent lists the child, then no longer.
    await setValues(chat, parent, { items: [ref(child)] });
    expect(await foundIn(chat, idNeedles([child]))).toEqual([parent]);
    await setValues(chat, parent, { items: [ref(other)] });
    expect(await foundIn(chat, idNeedles([child]))).toEqual([]);
    // The live row never listed the child; main does not see the pending edit.
    expect(await found(idNeedles([child]))).toEqual([]);
    expect(await found(idNeedles([other]))).toContain(parent);
  });

  it("a newer pending state of another chat supersedes this chat's older one", async () => {
    const child = await instance(cardId, { title: "Owners child" });
    const parent = await instance(listModuleId, { items: [] });
    const first = await draftChat("owner-a");
    const second = await draftChat("owner-b");

    await setValues(first, parent, { items: [ref(child)] });
    expect(await foundIn(second, idNeedles([child]))).toEqual([parent]);
    // Both chats share the draft: the newest pending state is the view.
    // The second chat has seen the first chat's change before building on it.
    await adapter.withAdminTransaction(second, (tx) =>
      observeDraftReads(tx, second, "contentInstance", [parent]),
    );
    await setValues(second, parent, { items: [] });
    expect(await foundIn(first, idNeedles([child]))).toEqual([]);
    expect(await foundIn(second, idNeedles([child]))).toEqual([]);
  });
});
