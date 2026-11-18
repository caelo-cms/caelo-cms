// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1268 — the draft head (`draft_pending_entities`, migration 0477).
 *
 *   - a write puts one head row per (entity, owner chat) on the branch,
 *     pointing at the owner's newest pending snapshot;
 *   - a partial Stage, an undo of the newest of several writes and a
 *     discard leave the head exact (the preload's after-file check holds
 *     every other file to maintained == rebuilt; here each step is checked);
 *   - the pill, the cross-chat banner, the changes page and the Stage list
 *     count the same entities, themes and layout chrome included;
 *   - the rebuild op reports drift and repairs it;
 *   - the TypeScript kinds mirror the SQL registry;
 *   - 20 concurrent writers on the shared draft, subagents of one chat
 *     among them, never wait on each other through the head.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { DRAFT_HEAD_KINDS } from "../draft.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const HUMAN = "00000000-0000-0000-0000-00000000ffff";
const PFX = "t1268-head-";
const SYS: ExecutionContext = { actorId: HUMAN, actorKind: "system", requestId: "t1268" };

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

beforeAll(() => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

afterAll(async () => {
  // Templates, pages and modules survive the per-file reset (seed-bearing
  // tables): a published page left behind without a meta description would
  // make the next file's Stage refuse its build.
  await asSystem(async (tx) => {
    const tpl = `${PFX}%`;
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT p.id FROM pages p JOIN templates t ON t.id = p.template_id WHERE t.slug LIKE ${tpl})`;
    await tx`DELETE FROM pages WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE ${tpl})`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE ${tpl})`;
    await tx`DELETE FROM templates WHERE slug LIKE ${tpl}`;
    await tx`DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE slug LIKE ${tpl})`;
  });
  await adapter.close();
});

async function asSystem<T>(query: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string, { max: 1 });
  try {
    return (await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return query(tx as unknown as SQL);
    })) as T;
  } finally {
    await sql.end();
  }
}

async function op<T>(ctx: ExecutionContext, name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

interface Chat {
  id: string;
  branch: string;
  ctx: ExecutionContext;
}

async function chat(title: string): Promise<Chat> {
  const v = await op<{ chatSessionId: string; chatBranchId: string }>(SYS, "chat.create_session", {
    title: `${PFX}${title}`,
  });
  return {
    id: v.chatSessionId,
    branch: v.chatBranchId,
    ctx: {
      actorId: HUMAN,
      actorKind: "ai",
      requestId: `t1268-${title}`,
      chatBranchId: v.chatBranchId,
      chatTaskId: v.chatSessionId,
    },
  };
}

async function seedModule(slug: string): Promise<string> {
  return (
    await op<{ moduleId: string }>(SYS, "modules.create", {
      slug: `${PFX}${slug}`,
      displayName: slug,
      html: `<p>${slug} v0</p>`,
    })
  ).moduleId;
}

/** Published pages of a template of their own: where seeded sections are placed. */
async function seedPages(slug: string, n: number): Promise<string[]> {
  const { templateId } = await op<{ templateId: string }>(SYS, "templates.create", {
    pageType: "home",
    slug: `${PFX}${slug}-tpl`,
    displayName: `${slug} template`,
    html: '<body><caelo-slot name="content">_</caelo-slot></body>',
  });
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const { pageId } = await op<{ pageId: string }>(SYS, "pages.create", {
      slug: `${PFX}${slug}-${i}`,
      title: `${slug} page ${i}`,
      templateId,
      status: "published",
    });
    ids.push(pageId);
  }
  return ids;
}

/** One content instance of `moduleId` placed on every one of `pageIds`; returns its id. */
async function placeContent(moduleId: string, pageIds: readonly string[]): Promise<string> {
  return asSystem(async (tx) => {
    const ci = (await tx`
      INSERT INTO content_instances (module_id, "values") VALUES (${moduleId}::uuid, '{}'::jsonb)
      RETURNING id::text AS id`) as { id: string }[];
    const id = ci[0]?.id ?? "";
    for (const pageId of pageIds) {
      await tx`INSERT INTO page_modules (page_id, block_name, position, module_id, content_instance_id, sync_mode)
               VALUES (${pageId}::uuid, 'content',
                       (SELECT count(*)::int FROM page_modules WHERE page_id = ${pageId}::uuid),
                       ${moduleId}::uuid, ${id}::uuid,
                       ${pageIds.length > 1 ? "synced" : "unsynced"})`;
    }
    return id;
  });
}

/**
 * Write a module from a chat. A write over another chat's newer change is
 * refused once as a conflict (which records that this chat has now seen
 * it); the retry builds on it — what the AI does after the conflict.
 */
async function writeModule(c: Chat, moduleId: string, html: string): Promise<void> {
  const first = await execute(registry, adapter, c.ctx, "modules.update", { moduleId, html });
  if (first.ok) return;
  if (!("conflict" in first.error && first.error.conflict)) {
    throw new Error(`modules.update: ${JSON.stringify(first.error)}`);
  }
  await op(c.ctx, "modules.update", { moduleId, html });
}

interface HeadRow {
  kind: string;
  entity: string;
  owner: string | null;
  header: string;
}

async function head(branch: string): Promise<HeadRow[]> {
  return asSystem(
    (tx) =>
      tx`SELECT entity_kind AS kind, entity_id::text AS entity, owner_chat_session_id::text AS owner,
                site_snapshot_id::text AS header
           FROM draft_pending_entities WHERE chat_branch_id = ${branch}::uuid
          ORDER BY entity_kind, entity_id, owner_chat_session_id` as Promise<HeadRow[]>,
  );
}

/** Maintained head == head rebuilt from the history (empty = consistent). */
async function drift(): Promise<unknown[]> {
  return asSystem(
    (tx) =>
      tx.unsafe(`
        WITH computed AS (SELECT * FROM caelo_draft_head_computed())
        SELECT 'stale' AS side, to_jsonb(s) AS row
          FROM (SELECT * FROM draft_pending_entities EXCEPT SELECT * FROM computed) s
        UNION ALL
        SELECT 'missing', to_jsonb(m)
          FROM (SELECT * FROM computed EXCEPT SELECT * FROM draft_pending_entities) m`) as Promise<
        unknown[]
      >,
  );
}

async function newestModuleHeader(c: Chat, moduleId: string): Promise<string> {
  const rows = await asSystem(
    (tx) =>
      tx`SELECT ss.id::text AS id FROM module_snapshots ms
           JOIN site_snapshots ss ON ss.id = ms.site_snapshot_id
          WHERE ms.module_id = ${moduleId}::uuid AND ss.chat_task_id = ${c.id}::uuid
            AND ss.staged_at IS NULL AND ss.undone_at IS NULL
          ORDER BY ss.created_at DESC, ms.created_at DESC LIMIT 1` as Promise<{ id: string }[]>,
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("no pending module snapshot");
  return id;
}

describe("#1268 draft head", () => {
  it("keeps one row per entity and owner, pointing at the owner's newest pending snapshot", async () => {
    const m = await seedModule("hero");
    const a = await chat("A");
    const b = await chat("B");
    await writeModule(a, m, "<p>hero A1</p>");
    await writeModule(a, m, "<p>hero A2</p>");
    await writeModule(b, m, "<p>hero B1</p>");
    const rows = (await head(a.branch)).filter((r) => r.entity === m);
    expect(rows.map((r) => r.owner).sort()).toEqual([a.id, b.id].sort());
    expect(rows.find((r) => r.owner === a.id)?.header).toBe(await newestModuleHeader(a, m));
    expect(rows.find((r) => r.owner === b.id)?.header).toBe(await newestModuleHeader(b, m));
    expect(await drift()).toEqual([]);
  });

  it("stays exact through a partial Stage", async () => {
    const x = await seedModule("stage-x");
    const y = await seedModule("stage-y");
    const a = await chat("stage A");
    const b = await chat("stage B");
    await writeModule(a, x, "<p>x from A</p>");
    await writeModule(b, y, "<p>y from B</p>");
    await op(SYS, "chat.merge_draft_to_main", { chatSessionIds: [a.id] });
    const rows = await head(a.branch);
    expect(rows.some((r) => r.entity === x)).toBe(false);
    expect(rows.some((r) => r.entity === y && r.owner === b.id)).toBe(true);
    expect(await drift()).toEqual([]);
  });

  it("recomputes, not deletes, when the newest of several writes is undone", async () => {
    const m = await seedModule("undo");
    const a = await chat("undo A");
    const b = await chat("undo B");
    await writeModule(a, m, "<p>undo A</p>");
    const aHeader = await newestModuleHeader(a, m);
    await writeModule(b, m, "<p>undo B (newest)</p>");
    await op(SYS, "chat.undo_changes", { chatSessionId: b.id });
    const rows = (await head(a.branch)).filter((r) => r.entity === m);
    expect(rows).toEqual([{ kind: "module", entity: m, owner: a.id, header: aHeader }]);
    expect(await drift()).toEqual([]);
  });

  it("drops a discarded draft chat's rows and nobody else's", async () => {
    const x = await seedModule("discard-x");
    const y = await seedModule("discard-y");
    const a = await chat("discard A");
    const b = await chat("discard B");
    await writeModule(a, x, "<p>x from A</p>");
    await writeModule(b, y, "<p>y from B</p>");
    await op(SYS, "chat.discard_branch", { chatSessionId: a.id });
    const rows = await head(a.branch);
    expect(rows.some((r) => r.owner === a.id)).toBe(false);
    expect(rows.some((r) => r.entity === y && r.owner === b.id)).toBe(true);
    expect(await drift()).toEqual([]);
  });

  it("counts the same pending changes in the pill, the changes page, its summary and the Stage list", async () => {
    const m = await seedModule("count");
    // On two pages, so its change is a site-wide one (a section design on
    // one page is a change of that page, one on none is not listed).
    for (const pageId of await seedPages("count", 2)) await placeContent(m, [pageId]);
    const a = await chat("count A");
    await writeModule(a, m, "<p>count 1</p>");
    await writeModule(a, m, "<p>count 2</p>");
    await op(a.ctx, "themes.update_meta", { displayName: `${PFX}theme from A` });

    const pill = await op<{ count: number; byKind: { modules: number; themes: number } }>(
      SYS,
      "chat.branch_change_count",
      { chatSessionId: a.id },
    );
    expect(pill.byKind.modules).toBe(1);
    expect(pill.byKind.themes).toBe(1);

    const changes = await op<{
      chats: {
        chatSessionId: string;
        pendingCount: number;
        summary: { siteWide: number; rows: { what: string }[] };
      }[];
    }>(SYS, "chat.list_open_changes", {});
    const list = await op<{
      pending: { pages: unknown[]; globals: { kind: string }[]; lists: unknown[] };
      staged: { pages: unknown[]; globals: unknown[]; lists: unknown[] };
    }>(SYS, "chat.list_pending_changes", { chatSessionId: a.id });
    const listed =
      list.pending.pages.length +
      list.pending.globals.length +
      list.pending.lists.length +
      list.staged.pages.length +
      list.staged.globals.length +
      list.staged.lists.length;

    expect(pill.count).toBe(2);
    const fromA = changes.chats.find((c) => c.chatSessionId === a.id);
    expect(fromA?.pendingCount).toBe(pill.count);
    // The Draft changes panel shows the same two changes as site-wide parts.
    expect(fromA?.summary.siteWide).toBe(pill.count);
    expect(fromA?.summary.rows.map((r) => r.what).sort()).toEqual([
      "Colours and fonts",
      "Section design · on 2 pages",
    ]);
    expect(listed).toBe(pill.count);
    expect(list.pending.globals.map((g) => g.kind).sort()).toEqual(["module", "theme"]);
  });

  it("counts a section's own content as a change of its page, and shared content where it shows", async () => {
    const m = await asSystem(async (tx) => {
      const r = (await tx`
        INSERT INTO modules (slug, display_name, type, html, fields)
        VALUES (${`${PFX}tile`}, 'Tile', ${`${PFX}tile`}, '<h2>{{headline}}</h2>',
                '[{"name":"headline","kind":"text"}]'::jsonb)
        RETURNING id::text AS id`) as { id: string }[];
      return r[0]?.id ?? "";
    });
    const [first, second] = await seedPages("content", 2);
    if (!first || !second) throw new Error("no pages");
    const own = await placeContent(m, [first]);
    const shared = await placeContent(m, [first, second]);
    const a = await chat("content A");
    for (const id of [own, shared]) {
      await op(a.ctx, "content_instances.set_values", { id, values: { headline: "v1" } });
    }

    const changes = await op<{
      chats: {
        chatSessionId: string;
        changes: { pending: { globals: { kind: string; label: string }[] } };
        summary: {
          changedPages: number;
          siteWide: number;
          rows: { area: string; title: string; what: string; pageId: string | null }[];
        };
      }[];
    }>(SYS, "chat.list_open_changes", {});
    const fromA = changes.chats.find((c) => c.chatSessionId === a.id);
    // Unnamed content is named by its section design, never by its id.
    expect(fromA?.changes.pending.globals.map((g) => g.label)).toEqual(["Tile", "Tile"]);
    expect(fromA?.summary.changedPages).toBe(1);
    expect(fromA?.summary.siteWide).toBe(1);
    expect(fromA?.summary.rows.map((r) => [r.area, r.title, r.what, r.pageId])).toEqual([
      ["page", "content page 0", "Text and images", first],
      ["siteWide", "Tile", "Shared content · on 2 pages", null],
    ]);
  });

  it("reads a bounded sample of a widely used section and still counts it as site-wide", async () => {
    const tile = await seedModule("bounded");
    const [first] = await seedPages("bounded", 1);
    if (!first) throw new Error("no page");
    // 101 placements of one synced content (one more than PART_PAGE_CAP),
    // on pages of their own, and 102 unused instances of another section
    // (one more than PART_INSTANCE_CAP, plus the one the chat deletes).
    const synced = await asSystem(async (tx) => {
      const tpl = (await tx`SELECT template_id::text AS id FROM pages WHERE id = ${first}::uuid`) as {
        id: string;
      }[];
      const ci = (await tx`
        INSERT INTO content_instances (module_id, "values") VALUES (${tile}::uuid, '{}'::jsonb)
        RETURNING id::text AS id`) as { id: string }[];
      await tx.unsafe(`
        WITH p AS (
          INSERT INTO pages (slug, title, short_title, template_id, page_type_confirmed, current_path, status)
          SELECT '${PFX}bounded-x-' || i, 'x ' || i, 'x ' || i, '${tpl[0]?.id}', true, '/${PFX}bounded-x-' || i, 'draft'
            FROM generate_series(1, 101) i RETURNING id)
        INSERT INTO page_modules (page_id, block_name, position, module_id, content_instance_id, sync_mode)
        SELECT p.id, 'content', 0, '${tile}', '${ci[0]?.id}', 'synced' FROM p`);
      return ci[0]?.id ?? "";
    });
    const unused = await seedModule("bounded-unused");
    const sampled = await asSystem(async (tx) => {
      const rows = (await tx.unsafe(`
        INSERT INTO content_instances (module_id, "values")
        SELECT '${unused}', '{}'::jsonb FROM generate_series(1, 102)
        RETURNING id::text AS id`)) as { id: string }[];
      return rows[0]?.id ?? "";
    });
    const a = await chat("bounded A");
    await op(a.ctx, "content_instances.set_values", { id: synced, values: {} });
    await writeModule(a, unused, "<p>bounded v1</p>");
    // A pending deletion of a sampled instance must not shrink the sample
    // below the cap (Codex review of #1658).
    await op(a.ctx, "content_instances.delete", { id: sampled });

    const changes = await op<{
      chats: { chatSessionId: string; summary: { rows: { title: string; what: string }[] } }[];
    }>(SYS, "chat.list_open_changes", {});
    const rows = changes.chats.find((c) => c.chatSessionId === a.id)?.summary.rows ?? [];
    expect(rows.map((r) => `${r.title}:${r.what}`).sort()).toEqual([
      "bounded-unused:Section design · on many pages",
      "bounded:Shared content · on many pages",
    ]);
  });

  it("pages the changes overview with a keyset cursor", async () => {
    const chats: Chat[] = [];
    for (const i of [1, 2, 3]) {
      const c = await chat(`page ${i}`);
      await writeModule(c, await seedModule(`page-${i}`), `<p>page ${i}</p>`);
      chats.push(c);
    }
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const page = await op<{ chats: { chatSessionId: string }[]; nextCursor: string | null }>(
        SYS,
        "chat.list_open_changes",
        { limit: 1, ...(cursor ? { cursor } : {}) },
      );
      for (const c of page.chats) {
        expect(seen.has(c.chatSessionId)).toBe(false);
        seen.add(c.chatSessionId);
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    for (const c of chats) expect(seen.has(c.id)).toBe(true);
    const bad = await execute(registry, adapter, SYS, "chat.list_open_changes", {
      cursor: "not-a-cursor",
    });
    expect(bad.ok).toBe(false);
  });

  it("rebuilds from source and reports the drift it repaired", async () => {
    const m = await seedModule("rebuild");
    const a = await chat("rebuild A");
    await writeModule(a, m, "<p>rebuild</p>");
    await asSystem((tx) => tx`DELETE FROM draft_pending_entities WHERE entity_id = ${m}::uuid`);
    expect((await drift()).length).toBe(1);
    const r = await op<{ rows: number; stale: number; missing: number }>(
      SYS,
      "chat.rebuild_draft_head",
      {},
    );
    expect(r.missing).toBe(1);
    expect(r.stale).toBe(0);
    expect(await drift()).toEqual([]);
    const refused = await execute(registry, adapter, a.ctx, "chat.rebuild_draft_head", {});
    expect(refused.ok).toBe(false);
  });

  it("recomputes the SEO mark when an older SEO change is staged under a newer edit", async () => {
    const a = await chat("seo A");
    const page = await asSystem(
      (tx) =>
        tx`INSERT INTO pages (slug, title, short_title, template_id, page_type_id, page_type_confirmed,
                              current_path, status)
           SELECT ${`${PFX}seo`}, 'SEO page', 'SEO page', t.id, pt.id, true, ${`/${PFX}seo`}, 'draft'
             FROM templates t, page_types pt
            WHERE t.slug = 'home-template' AND pt.slug = 'home' AND pt.chat_branch_id IS NULL
            LIMIT 1
           RETURNING id::text AS id` as Promise<{ id: string }[]>,
    );
    const pageId = page[0]?.id ?? "";
    // An SEO edit, then a newer non-SEO edit of the same page (seeded like a
    // deferred Stage leaves them: the older header is finalized later).
    const headers: string[] = [];
    for (const [i, opKind] of ["pages_seo.set", "pages.update"].entries()) {
      const h = await asSystem(
        (tx) =>
          tx`WITH h AS (
               INSERT INTO site_snapshots (actor_id, op_kind, description, chat_task_id, chat_branch_id,
                                           created_at)
               VALUES (${HUMAN}::uuid, ${opKind}, ${`${PFX}seo`}, ${a.id}::uuid, ${a.branch}::uuid,
                       now() + make_interval(secs => ${i}))
               RETURNING id, created_at)
             INSERT INTO page_snapshots (site_snapshot_id, page_id, state, created_at)
             SELECT h.id, ${pageId}::uuid, '{"slug": "seo"}'::jsonb, h.created_at FROM h
             RETURNING site_snapshot_id::text AS id` as Promise<{ id: string }[]>,
      );
      headers.push(h[0]?.id ?? "");
    }
    const seo = async () =>
      (
        await asSystem(
          (tx) =>
            tx`SELECT seo_changed FROM draft_pending_entities
                WHERE entity_kind = 'page' AND entity_id = ${pageId}::uuid` as Promise<
              { seo_changed: boolean }[]
            >,
        )
      )[0]?.seo_changed;
    expect(await seo()).toBe(true);
    await asSystem(
      (tx) => tx`UPDATE site_snapshots SET staged_at = now() WHERE id = ${headers[0]}::uuid`,
    );
    expect(await seo()).toBe(false);
    expect(await drift()).toEqual([]);
  });

  it("re-attributes a deleted subagent's pending changes, as the Stage selection does", async () => {
    const parent = await chat("gc parent");
    const m = await seedModule("gc");
    const sub = await asSystem(
      (tx) =>
        tx`INSERT INTO chat_sessions (title, created_by, chat_branch_id, branch_kind,
                                      parent_chat_session_id, subagent_role)
           SELECT ${`${PFX}gc-sub`}, created_by, chat_branch_id, branch_kind, id, 'worker'
             FROM chat_sessions WHERE id = ${parent.id}::uuid
           RETURNING id::text AS id` as Promise<{ id: string }[]>,
    );
    const subId = sub[0]?.id ?? "";
    await asSystem(
      (tx) =>
        tx`WITH h AS (
             INSERT INTO site_snapshots (actor_id, op_kind, description, chat_task_id, chat_branch_id)
             VALUES (${HUMAN}::uuid, 'modules.update', ${`${PFX}gc`}, ${subId}::uuid, ${parent.branch}::uuid)
             RETURNING id)
           INSERT INTO module_snapshots (site_snapshot_id, module_id, state)
           SELECT h.id, ${m}::uuid, '{"html": "<p>gc</p>"}'::jsonb FROM h`,
    );
    const owner = async () =>
      (await head(parent.branch)).find((r) => r.entity === m)?.owner ?? null;
    expect(await owner()).toBe(parent.id);
    await asSystem((tx) => tx`DELETE FROM chat_sessions WHERE id = ${subId}::uuid`);
    expect(await owner()).toBe(subId);
    expect(await drift()).toEqual([]);
  });

  it("keeps plugin rows of two tables with the same row id apart", async () => {
    const a = await chat("plugin rows");
    const rowId = crypto.randomUUID();
    await asSystem(
      (tx) =>
        tx`WITH pl AS (
             INSERT INTO plugins (id, slug, version, tier, status, manifest_json, manifest_signature,
                                  submitted_by)
             VALUES ('00000000-0000-4000-8000-000000001268', ${`${PFX}plugin`}, '0.1.0', 1, 'disabled',
                     '{}'::jsonb, 'fixture', ${HUMAN}::uuid)
             ON CONFLICT (id) DO NOTHING RETURNING id),
           h AS (
             INSERT INTO site_snapshots (actor_id, op_kind, description, chat_task_id, chat_branch_id)
             VALUES (${HUMAN}::uuid, 'plugin_storage.update', ${`${PFX}rows`}, ${a.id}::uuid, ${a.branch}::uuid)
             RETURNING id)
           INSERT INTO plugin_row_snapshots (site_snapshot_id, plugin_id, schema_name, table_name, row_id, state)
           SELECT h.id, '00000000-0000-4000-8000-000000001268', 'plugin_t1268', t, ${rowId}::uuid, '{}'::jsonb
             FROM h, unnest(ARRAY['first_table', 'second_table']) AS t`,
    );
    const rows = (await head(a.branch)).filter((r) => r.kind === "pluginRow" && r.entity === rowId);
    expect(rows.length).toBe(2);
    expect(await drift()).toEqual([]);
  });

  // #1411 — the branch views read a plugin row's page from the head. The
  // column belongs to the plugin, so a value that is no uuid is no page,
  // never a failed plugin write.
  it("names the page of a plugin row, and no page for a value that is not a uuid", async () => {
    const a = await chat("plugin row page");
    const pageId = crypto.randomUUID();
    const pluginId = "00000000-0000-4000-8000-000000001411";
    const states = [{ page_id: pageId }, { page_id: "not-a-uuid" }, { page_id: 7 }, {}];
    await asSystem(
      (tx) =>
        tx`INSERT INTO plugins (id, slug, version, tier, status, manifest_json, manifest_signature,
                                submitted_by)
           VALUES (${pluginId}::uuid, ${`${PFX}plugin-1411`}, '0.1.0', 1, 'disabled', '{}'::jsonb,
                   'fixture', ${HUMAN}::uuid)`,
    );
    for (const values of states) {
      const state = JSON.stringify({ values });
      await asSystem(
        (tx) =>
          tx`WITH h AS (
               INSERT INTO site_snapshots (actor_id, op_kind, description, chat_task_id, chat_branch_id)
               VALUES (${HUMAN}::uuid, 'plugin_storage.update', ${`${PFX}row-page`}, ${a.id}::uuid, ${a.branch}::uuid)
               RETURNING id)
             INSERT INTO plugin_row_snapshots (site_snapshot_id, plugin_id, schema_name, table_name, row_id, state)
             SELECT h.id, ${pluginId}::uuid, 'plugin_t1411', 'rows', gen_random_uuid(), ${state}::text::jsonb
               FROM h`,
      );
    }
    const named = await asSystem(
      (tx) =>
        tx`SELECT page_id::text AS page_id FROM draft_pending_entities
            WHERE chat_branch_id = ${a.branch}::uuid AND plugin_id = ${pluginId}::uuid
              AND page_id IS NOT NULL` as Promise<{ page_id: string }[]>,
    );
    expect(named).toEqual([{ page_id: pageId }]);
    expect(await drift()).toEqual([]);
  });

  it("follows a subagent unlinked from its parent, and session GC keeps a session that owns pending changes", async () => {
    const parent = await chat("unlink parent");
    const m = await seedModule("unlink");
    const sub = await asSystem(
      (tx) =>
        tx`INSERT INTO chat_sessions (title, created_by, chat_branch_id, branch_kind,
                                      parent_chat_session_id, subagent_role)
           SELECT ${`${PFX}unlink-sub`}, created_by, chat_branch_id, branch_kind, id, 'worker'
             FROM chat_sessions WHERE id = ${parent.id}::uuid
           RETURNING id::text AS id` as Promise<{ id: string }[]>,
    );
    const subId = sub[0]?.id ?? "";
    await asSystem(
      (tx) =>
        tx`WITH h AS (
             INSERT INTO site_snapshots (actor_id, op_kind, description, chat_task_id, chat_branch_id)
             VALUES (${HUMAN}::uuid, 'modules.update', ${`${PFX}unlink`}, ${subId}::uuid, ${parent.branch}::uuid)
             RETURNING id)
           INSERT INTO module_snapshots (site_snapshot_id, module_id, state)
           SELECT h.id, ${m}::uuid, '{"html": "<p>unlink</p>"}'::jsonb FROM h`,
    );
    // A finished run long past retention: GC must still keep the session.
    await asSystem(
      (tx) =>
        tx`INSERT INTO subagent_runs (parent_chat_session_id, subagent_chat_session_id, role, task,
                                      status, finished_at)
           VALUES (${parent.id}::uuid, ${subId}::uuid, 'worker', 'test', 'completed',
                   now() - interval '90 days')`,
    );
    const gc = await op<{ sessionsDeleted: number }>(SYS, "subagent_runs.gc_old_sessions", {
      retentionDays: 30,
    });
    expect(gc.sessionsDeleted).toBe(0);
    const owner = async () =>
      (await head(parent.branch)).find((r) => r.entity === m)?.owner ?? null;
    expect(await owner()).toBe(parent.id);
    // What the self-FK does when the parent is deleted.
    await asSystem(
      (tx) => tx`UPDATE chat_sessions SET parent_chat_session_id = NULL WHERE id = ${subId}::uuid`,
    );
    expect(await owner()).toBe(subId);
    expect(await drift()).toEqual([]);
  });

  it("lists an entity with several stage marks once, pending when its newest edit is unmarked", async () => {
    const m = await seedModule("marks");
    const exp = await op<{ chatSessionId: string; chatBranchId: string }>(
      SYS,
      "chat.create_session",
      { title: `${PFX}marks`, isolation: "experiment" },
    );
    const ctx: ExecutionContext = {
      actorId: HUMAN,
      actorKind: "ai",
      requestId: "t1268-marks",
      chatBranchId: exp.chatBranchId,
      chatTaskId: exp.chatSessionId,
    };
    await op(ctx, "modules.update", { moduleId: m, html: "<p>marks 1</p>" });
    await op(ctx, "modules.update", { moduleId: m, html: "<p>marks 2</p>" });
    await op(ctx, "modules.update", { moduleId: m, html: "<p>marks 3</p>" });
    // Two marks of the module, on the two OLDER snapshots of the three.
    const marked = await asSystem(
      (tx) =>
        tx`INSERT INTO chat_branch_publish_marks (chat_branch_id, entity_kind, entity_id, site_snapshot_id, stage_state)
           SELECT ${exp.chatBranchId}::uuid, 'module', ${m}::uuid, o.id,
                  CASE WHEN o.n = 1 THEN 'published' ELSE 'staged' END
             FROM (SELECT ss.id, row_number() OVER (ORDER BY ss.created_at) AS n
                     FROM module_snapshots ms JOIN site_snapshots ss ON ss.id = ms.site_snapshot_id
                    WHERE ms.module_id = ${m}::uuid AND ss.chat_branch_id = ${exp.chatBranchId}::uuid) o
            WHERE o.n <= 2
           RETURNING 1` as Promise<unknown[]>,
    );
    expect(marked.length).toBe(2);
    const list = await op<{
      pending: { globals: { kind: string; entityId: string }[] };
      staged: { globals: { kind: string; entityId: string }[] };
    }>(SYS, "chat.list_pending_changes", { chatSessionId: exp.chatSessionId });
    expect(list.pending.globals.filter((g) => g.entityId === m).length).toBe(1);
    expect(list.staged.globals.filter((g) => g.entityId === m).length).toBe(0);
  });

  it("mirrors the SQL registry of head kinds", async () => {
    const rows = await asSystem(
      (tx) => tx`SELECT kind FROM caelo_draft_head_tables()` as Promise<{ kind: string }[]>,
    );
    expect([...rows.map((r) => r.kind), "layoutChrome"].sort()).toEqual(
      [...DRAFT_HEAD_KINDS].sort(),
    );
  });

  it("lets 20 concurrent draft writers, subagents of one chat among them, write without waiting on each other", async () => {
    const parent = await chat("concurrent parent");
    const owners: string[] = [];
    for (let i = 0; i < 20; i++) {
      if (i < 5) {
        // Subagents of one chat: their writes all belong to `parent`.
        const sub = await asSystem(
          (tx) =>
            tx`INSERT INTO chat_sessions (title, created_by, chat_branch_id, branch_kind,
                                          parent_chat_session_id, subagent_role)
               SELECT ${`${PFX}sub-${i}`}, created_by, chat_branch_id, branch_kind, id, 'worker'
                 FROM chat_sessions WHERE id = ${parent.id}::uuid
               RETURNING id::text AS id` as Promise<{ id: string }[]>,
        );
        owners.push(sub[0]?.id ?? "");
      } else {
        owners.push((await chat(`concurrent ${i}`)).id);
      }
    }
    const modules: string[] = [];
    for (let i = 0; i < 20; i++) modules.push(await seedModule(`concurrent-${i}`));

    // Every writer opens its transaction, writes a header + a module
    // snapshot (the head row is upserted by the trigger) and HOLDS the
    // transaction open until all 20 have written. A writer that had to wait
    // on another through the head would hit its lock timeout instead.
    const pools = owners.map(() => new SQL(ADMIN_URL as string, { max: 1 }));
    let release: () => void = () => {};
    const allWritten = new Promise<void>((resolve) => {
      release = resolve;
    });
    let written = 0;
    try {
      const writers = owners.map((task, i) =>
        pools[i]?.begin(async (tx) => {
          await tx.unsafe("SET LOCAL caelo.actor_kind = 'ai'");
          await tx.unsafe("SET LOCAL lock_timeout = '3s'");
          const h = (await tx`
            INSERT INTO site_snapshots (actor_id, op_kind, description, chat_task_id, chat_branch_id)
            VALUES (${HUMAN}::uuid, 'modules.update', ${`${PFX}concurrent`}, ${task}::uuid, ${parent.branch}::uuid)
            RETURNING id::text AS id`) as { id: string }[];
          await tx`
            INSERT INTO module_snapshots (site_snapshot_id, module_id, state)
            VALUES (${h[0]?.id}::uuid, ${modules[i]}::uuid, '{"html": "<p>concurrent</p>"}'::jsonb)`;
          written += 1;
          if (written === owners.length) release();
          await allWritten;
        }),
      );
      await Promise.all(writers);
    } finally {
      await Promise.all(pools.map((p) => p.end()));
    }
    const rows = (await head(parent.branch)).filter((r) => modules.includes(r.entity));
    expect(rows.length).toBe(20);
    // Subagent writes belong to their parent chat.
    expect(rows.filter((r) => r.owner === parent.id).length).toBe(5);
    expect(await drift()).toEqual([]);
  }, 60_000);
});
