// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 part D — reference integrity for lists against a real
 * Postgres (docs/lists.md §11):
 *
 *   - a shared list deleted in one chat while main still binds it refuses
 *     that chat's Stage, naming the module, the field and the page;
 *   - a page term whose vocabulary entry a chat removed refuses the Stage;
 *   - a query's `terms` pointing at a removed entry refuses the Stage;
 *   - a migration chat writes a menu linking a page its import run builds
 *     later: the link is recorded against the list and resolves into a
 *     page reference once the page exists.
 *
 * The deletes race a binding made on main after the chat read the list
 * (the delete op itself refuses while the list is bound in its view):
 * the Stage merge is where the two meet, and the gate stops it.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext, ListItem } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ID = "00000000-0000-0000-0000-00000000ffff";
const SYS: ExecutionContext = { actorId: SYSTEM_ID, actorKind: "system", requestId: "t1107d" };
const PFX = `t1107d${Date.now().toString(36)}`;
const SOURCE = `https://${PFX}.source.test`;

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let templateId = "";

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

async function op<T>(ctx: ExecutionContext, name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function stageRefusal(chatSessionId: string): Promise<string> {
  const r = await execute(registry, adapter, SYS, "chat.merge_to_main", { chatSessionId });
  if (r.ok) throw new Error("Stage unexpectedly went through");
  return "message" in r.error ? String(r.error.message) : JSON.stringify(r.error);
}

async function experiment(title: string): Promise<{ id: string; ctx: ExecutionContext }> {
  const v = await op<{ chatSessionId: string; chatBranchId: string }>(SYS, "chat.create_session", {
    title: `${PFX}-${title}`,
    isolation: "experiment",
  });
  return {
    id: v.chatSessionId,
    ctx: {
      actorId: SYSTEM_ID,
      actorKind: "ai",
      requestId: `t1107d-${title}`,
      chatBranchId: v.chatBranchId,
      chatTaskId: v.chatSessionId,
    },
  };
}

async function getList(
  ctx: ExecutionContext,
  slug: string,
): Promise<{ id: string; items: ListItem[] }> {
  return (await op<{ list: { id: string; items: ListItem[] } }>(ctx, "lists.get", { slug })).list;
}

/** A vocabulary with entries `a` and `b`; returns their term references. */
async function vocabulary(
  slug: string,
): Promise<{ id: string; a: string; b: string; bId: string }> {
  await op(SYS, "lists.upsert_many", {
    lists: [
      {
        slug,
        name: `${slug} tags`,
        purpose: "Topics pages are tagged with",
        type: "tags",
        items: [
          { node: "tag", values: { name: "A", slug: "a" } },
          { node: "tag", values: { name: "B", slug: "b" } },
        ],
      },
    ],
  });
  const l = await getList(SYS, slug);
  const [a, b] = l.items;
  return {
    id: l.id,
    a: `caelo:term/${l.id}/${a?.id}`,
    b: `caelo:term/${l.id}/${b?.id}`,
    bId: b?.id ?? "",
  };
}

/** A published page whose type takes terms of `vocabId`. */
async function taggedPage(slug: string, vocabId: string, terms: string[]): Promise<string> {
  const typeSlug = `${PFX}-${slug}-type`;
  // A template of its own: the shared one must keep deciding its page
  // type alone for the build_page calls of the other tests.
  const own = (
    await op<{ templateId: string }>(SYS, "templates.create", {
      pageType: "home",
      slug: `${PFX}-${slug}-tpl`,
      displayName: `${PFX} ${slug}`,
      html: `<html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
    })
  ).templateId;
  await op(SYS, "page_types.upsert_many", {
    pageTypes: [
      {
        slug: typeSlug,
        name: `Tagged ${slug}`,
        purpose: "Pages carrying topics",
        templates: [own],
        defaultTemplate: own,
        properties: [],
        vocabularies: [{ list: vocabId, cardinality: "many" }],
      },
    ],
  });
  const { pageId } = await op<{ pageId: string }>(SYS, "pages.create", {
    slug: `${PFX}-${slug}`,
    title: slug,
    pageType: typeSlug,
    terms,
  });
  await op(SYS, "pages.set_status", { pageId, status: "published" });
  return pageId;
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  templateId = (
    await op<{ templateId: string }>(SYS, "templates.create", {
      pageType: "home",
      slug: `${PFX}-tpl`,
      displayName: `${PFX} TPL`,
      html: `<html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
    })
  ).templateId;
  await op(SYS, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
});

afterAll(async () => {
  // Templates, page types and list types survive the per-file reset.
  await asSystem(async (tx) => {
    await tx`DELETE FROM import_runs WHERE source_url = ${SOURCE}`;
    await tx`UPDATE pages SET deleted_at = now() WHERE slug LIKE ${`${PFX}%`}`;
    await tx`UPDATE page_types SET deleted_at = now() WHERE slug LIKE ${`${PFX}%`}`;
    await tx`UPDATE list_types SET deleted_at = now() WHERE slug LIKE ${`${PFX}%`}`;
    await tx`UPDATE templates SET deleted_at = now() WHERE slug LIKE ${`${PFX}%`}`;
  });
  await adapter.close();
});

describe("#1107 reference integrity — Stage gate", () => {
  it("a list deleted while still bound refuses the Stage, naming module, field and page", async () => {
    const slug = `${PFX}-nav`;
    await op(SYS, "lists.upsert_many", {
      lists: [
        {
          slug,
          name: "Main navigation",
          purpose: "Header navigation",
          type: "menu",
          items: [
            {
              node: "entry",
              values: { label: "Docs", link: { href: "https://example.com/docs" } },
            },
          ],
        },
      ],
    });
    const list = await getList(SYS, slug);
    // The chat deletes the list while nothing binds it in its view …
    const chat = await experiment("delete-list");
    await op(chat.ctx, "lists.delete_many", { slugs: [slug] });
    // … and main binds it meanwhile.
    await op(SYS, "pages.build_page", {
      page: { slug: `${PFX}-docs`, title: "Docs", templateId, status: "published" },
      modules: [
        {
          blockName: "content",
          displayName: `${PFX} Header`,
          html: '<nav>{{#nav}}<a href="{{link}}">{{label}}</a>{{/nav}}</nav>',
          fields: [
            { name: "nav", kind: "list", label: "Navigation", listType: "menu", bind: "shared" },
          ],
          content: { source: "inline", values: { nav: `caelo:list/${list.id}` } },
        },
      ],
    });
    const message = await stageRefusal(chat.id);
    expect(message).toStartWith("Stage refused");
    expect(message).toContain("Reference to a deleted list");
    expect(message).toContain(`field "nav" of module "${PFX} Header"`);
    expect(message).toContain(`"/${PFX}-docs"`);
    expect(message).toContain("set_page_module_content_many");
    // Rolled back: the list is still live on main.
    expect((await getList(SYS, slug)).id).toBe(list.id);
  });

  it("a page term whose vocabulary entry a chat removed refuses the Stage", async () => {
    const vocab = await vocabulary(`${PFX}-topics`);
    const chat = await experiment("remove-term");
    await op(chat.ctx, "lists.patch_items_many", {
      lists: [{ slug: `${PFX}-topics`, patches: [{ op: "remove", itemId: vocab.bId }] }],
    });
    await taggedPage("tagged", vocab.id, [vocab.a, vocab.b]);
    const message = await stageRefusal(chat.id);
    expect(message).toContain("Term of a removed vocabulary entry");
    expect(message).toContain(`in the terms of page "/${PFX}-tagged"`);
    expect(message).toContain(`entry ${vocab.bId}`);
    expect(message).toContain("update_pages_many");
  });

  it("a query term pointing at a removed vocabulary entry refuses the Stage", async () => {
    const vocab = await vocabulary(`${PFX}-subjects`);
    const typeSlug = `${PFX}-feed`;
    await op(SYS, "list_types.upsert_many", {
      listTypes: [
        {
          slug: typeSlug,
          name: "Topic feed",
          purpose: "Latest pages of a topic",
          role: "content",
          root: { allow: ["feed"] },
          nodes: {
            feed: {
              label: "Feed",
              fields: [{ name: "title", label: "Title", type: "text" }],
              source: {
                kind: "query",
                editable: ["terms", "limit"],
                defaults: { order: "published_desc", limit: 3 },
              },
            },
          },
        },
      ],
    });
    await op(SYS, "lists.upsert_many", {
      lists: [
        {
          slug: `${PFX}-feeds`,
          name: "Topic feeds",
          purpose: "Sidebar feeds",
          type: typeSlug,
          items: [{ node: "feed", values: { title: "About B" }, query: { terms: [vocab.b] } }],
        },
      ],
    });
    const feeds = await getList(SYS, `${PFX}-feeds`);
    const chat = await experiment("remove-query-term");
    await op(chat.ctx, "lists.patch_items_many", {
      lists: [{ slug: `${PFX}-subjects`, patches: [{ op: "remove", itemId: vocab.bId }] }],
    });
    await op(SYS, "pages.build_page", {
      page: { slug: `${PFX}-sidebar`, title: "Sidebar", templateId, status: "published" },
      modules: [
        {
          blockName: "content",
          displayName: `${PFX} Feeds`,
          html: '<aside>{{#feeds}}<h3>{{title}}</h3>{{#items}}<a href="{{link}}">{{title}}</a>{{/items}}{{/feeds}}</aside>',
          fields: [
            {
              name: "feeds",
              kind: "list",
              label: "Feeds",
              listType: typeSlug,
              bind: "shared",
              list: `caelo:list/${feeds.id}`,
            },
          ],
          content: { source: "inline", values: {} },
        },
      ],
    });
    const message = await stageRefusal(chat.id);
    expect(message).toContain("Term of a removed vocabulary entry");
    expect(message).toContain(`in shared list "Topic feeds"`);
    expect(message).toContain(`entry ${feeds.items[0]?.id}`);
    expect(message).toContain("patch_list_items_many");
  });
});

describe("#1107 pending import links in lists", () => {
  it("a menu linking a page the import builds later is recorded and resolves once the page exists", async () => {
    const session = await op<{ chatSessionId: string; chatBranchId: string }>(
      SYS,
      "chat.create_session",
      { title: `${PFX}-migration` },
    );
    const ai: ExecutionContext = {
      actorId: "00000000-0000-0000-0000-000000000a1a",
      actorKind: "ai",
      requestId: "t1107d-import",
      chatBranchId: session.chatBranchId,
      chatTaskId: session.chatSessionId,
    };
    const runId = (
      (await asSystem(
        (tx) => tx`INSERT INTO import_runs (source_url, proposed_by, status, chat_session_id)
                   VALUES (${SOURCE}, ${SYSTEM_ID}::uuid, 'ready_for_review', ${session.chatSessionId}::uuid)
                   RETURNING id::text AS id`,
      )) as { id: string }[]
    )[0]?.id as string;
    const importPageId = (
      (await asSystem(
        (
          tx,
        ) => tx`INSERT INTO import_pages (run_id, source_url, proposed_slug, proposed_title, proposed_modules)
                VALUES (${runId}::uuid, ${`${SOURCE}/${PFX}-pricing`}, ${`${PFX}-pricing`}, 'Pricing',
                        (${JSON.stringify([{ blockName: "content", position: 0, html: "<p>Prices</p>", displayName: "Body" }])}::text)::jsonb)
                RETURNING id::text AS id`,
      )) as { id: string }[]
    )[0]?.id as string;

    const slug = `${PFX}-migrated-nav`;
    const menu = {
      slug,
      name: "Migrated navigation",
      purpose: "Header navigation of the migrated site",
      type: "menu",
      items: [
        { node: "entry", values: { label: "Pricing", link: { href: `/${PFX}-pricing#plans` } } },
      ],
    };
    // Outside the import's chat the planned page is an unknown path.
    const strict = await execute(registry, adapter, SYS, "lists.upsert_many", { lists: [menu] });
    expect(strict.ok).toBe(false);
    if (!strict.ok) expect(JSON.stringify(strict.error)).toContain("is not the path of any page");

    const created = await op<{ lists: { id: string }[] }>(ai, "lists.upsert_many", {
      lists: [menu],
    });
    const listId = created.lists[0]?.id as string;
    const recorded = (await asSystem(
      (
        tx,
      ) => tx`SELECT value, status, entity_kind, entity_id::text AS entity_id FROM import_run_links
                  WHERE run_id = ${runId}::uuid`,
    )) as { value: string; status: string; entity_kind: string; entity_id: string }[];
    expect(recorded).toEqual([
      { value: `/${PFX}-pricing#plans`, status: "pending", entity_kind: "list", entity_id: listId },
    ]);
    // Kept literal in the chat's draft until the run finalises.
    const before = await getList(ai, slug);
    expect(before.items[0]?.values.link).toEqual({ href: `/${PFX}-pricing#plans` });

    const { pageId } = await op<{ pageId: string }>(ai, "pages.build_page", {
      page: {
        slug: `${PFX}-preise`,
        title: "Preise",
        templateId,
        status: "published",
        importPageId,
      },
      modules: [
        {
          blockName: "content",
          displayName: `${PFX} pricing body`,
          html: "<p>{{t}}</p>",
          fields: [{ name: "t", kind: "text", label: "T" }],
          content: { source: "inline", values: { t: "Prices" } },
        },
      ],
    });
    const out = await op<{ resolved: number; unresolved: unknown[] }>(ai, "imports.resolve_links", {
      runId,
    });
    expect(out).toEqual({ resolved: 1, unresolved: [] });
    // The stored entry is a page reference now (lists.get humanises reads,
    // so read the chat's snapshot of the list).
    const state = (
      (await asSystem(
        (tx) => tx`SELECT ls.state FROM list_snapshots ls
                     JOIN site_snapshots ss ON ss.id = ls.site_snapshot_id
                    WHERE ls.list_id = ${listId}::uuid AND ss.chat_branch_id = ${session.chatBranchId}::uuid
                    ORDER BY ss.created_at DESC LIMIT 1`,
      )) as { state: unknown }[]
    )[0]?.state;
    const items = (typeof state === "string" ? JSON.parse(state) : state) as { items: ListItem[] };
    expect(items.items[0]?.values.link).toEqual({ href: `caelo:page/${pageId}#plans` });
    const links = (await asSystem(
      (tx) => tx`SELECT status FROM import_run_links WHERE run_id = ${runId}::uuid`,
    )) as { status: string }[];
    expect(links.map((l) => l.status)).toEqual(["resolved"]);
  });
});
