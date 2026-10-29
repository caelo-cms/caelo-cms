// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 part B — the list / list type ops against a real Postgres:
 * draft overlay between two chats on the shared draft, stale writes,
 * delete refused while bound, type changes refused / accepted with
 * `dropValues`, undo + revert restore a list, Stage graduates a list
 * created in the draft, item patches, promote_local, permission gate and
 * the domain events.
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
const PFX = "t1107b-";
const SYS: ExecutionContext = { actorId: SYSTEM_ID, actorKind: "system", requestId: "t1107b" };

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

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  // List types are seed-bearing (kept across files by the test reset):
  // drop the ones an earlier run of this file created.
  await asSystem((tx) => tx`DELETE FROM list_types WHERE slug LIKE ${`${PFX}%`}`);
});

afterAll(async () => {
  await adapter.close();
});

async function op<T>(ctx: ExecutionContext, name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function fail(ctx: ExecutionContext, name: string, input: unknown): Promise<string> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (r.ok) throw new Error(`${name} unexpectedly succeeded: ${JSON.stringify(r.value)}`);
  return "message" in r.error ? r.error.message : JSON.stringify(r.error);
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
      actorId: SYSTEM_ID,
      actorKind: "ai",
      requestId: `t1107b-${title}`,
      chatBranchId: v.chatBranchId,
      chatTaskId: v.chatSessionId,
    },
  };
}

type ListOut = {
  list: {
    id: string;
    slug: string;
    version: number;
    items: ListItem[];
    usage: { modules: { slug: string }[] };
  };
};

async function getList(ctx: ExecutionContext, slug: string): Promise<ListOut["list"]> {
  return (await op<ListOut>(ctx, "lists.get", { slug })).list;
}

const menu = (labels: string[]) =>
  labels.map((label) => ({
    node: "entry",
    values: { label, link: { href: `https://example.com/${label}` } },
  }));

describe("#1107 list types", () => {
  it("lists the five shipped types as stored data", async () => {
    const v = await op<{ listTypes: { slug: string; role: string; listCount: number }[] }>(
      SYS,
      "list_types.list",
      {},
    );
    const slugs = v.listTypes.map((t) => t.slug);
    for (const s of ["texts", "links", "menu", "categories", "tags"]) expect(slugs).toContain(s);
    const vocab = await op<{ listTypes: { slug: string }[] }>(SYS, "list_types.list", {
      role: "vocabulary",
    });
    expect(vocab.listTypes.map((t) => t.slug).sort()).toEqual(
      expect.arrayContaining(["categories", "tags"]),
    );
  });

  it("refuses an invalid definition with the path and the next step", async () => {
    const msg = await fail(SYS, "list_types.upsert_many", {
      listTypes: [
        {
          slug: `${PFX}bad`,
          name: "Bad",
          purpose: "test",
          role: "content",
          root: { allow: ["nope"] },
          nodes: { item: { label: "Item", fields: [] } },
        },
      ],
    });
    expect(msg).toContain("root.allow");
    expect(msg).toContain('node kind "nope" is not defined');
  });

  it("refuses removing a field that still holds values, accepts it with dropValues, and applies a new default", async () => {
    const slug = `${PFX}cards`;
    const def = {
      slug,
      name: "Cards",
      purpose: "test cards",
      role: "content" as const,
      root: { allow: ["card"] },
      nodes: {
        card: {
          label: "Card",
          fields: [
            { name: "title", label: "Title", type: "text" as const, required: true },
            { name: "subtitle", label: "Subtitle", type: "text" as const },
          ],
        },
      },
    };
    await op(SYS, "list_types.upsert_many", { listTypes: [def] });
    await op(SYS, "lists.upsert_many", {
      lists: [
        {
          slug: `${PFX}card-list`,
          name: "Cards",
          purpose: "test",
          type: slug,
          items: [{ node: "card", values: { title: "A", subtitle: "sub A" } }],
        },
      ],
    });
    // A local list of the type inside a module field default + a content instance.
    const moduleId = crypto.randomUUID();
    const localItem = {
      id: crypto.randomUUID(),
      node: "card",
      values: { title: "L", subtitle: "sub L" },
    };
    await asSystem(
      (tx) => tx`
        INSERT INTO modules (id, slug, display_name, html, fields, type)
        VALUES (${moduleId}::uuid, ${`${PFX}card-module`}, 'Card module', '<div>{{#cards}}{{title}}{{/cards}}</div>',
                (${JSON.stringify([
                  {
                    name: "cards",
                    label: "Cards",
                    kind: "list",
                    listType: slug,
                    default: [localItem],
                  },
                ])}::text)::jsonb, 'card-module')`,
    );
    const ciId = crypto.randomUUID();
    const ciItem = {
      id: crypto.randomUUID(),
      node: "card",
      values: { title: "C", subtitle: "sub C" },
    };
    await asSystem(
      (tx) => tx`
        INSERT INTO content_instances (id, module_id, "values")
        VALUES (${ciId}::uuid, ${moduleId}::uuid, (${JSON.stringify({ cards: [ciItem] })}::text)::jsonb)`,
    );

    const withoutSubtitle = {
      ...def,
      nodes: { card: { label: "Card", fields: [def.nodes.card.fields[0]] } },
    };
    const refused = await fail(SYS, "list_types.upsert_many", { listTypes: [withoutSubtitle] });
    expect(refused).toContain(`list "${PFX}card-list"`);
    expect(refused).toContain(`module "${PFX}card-module"`);
    expect(refused).toContain("dropValues: true");

    const withBadge = {
      ...withoutSubtitle,
      nodes: {
        card: {
          label: "Card",
          fields: [
            def.nodes.card.fields[0],
            {
              name: "badge",
              label: "Badge",
              type: "text" as const,
              required: true,
              default: "new",
            },
          ],
        },
      },
    };
    const accepted = await op<{ listTypes: { listsRewritten: number }[] }>(
      SYS,
      "list_types.upsert_many",
      { listTypes: [withBadge], dropValues: true },
    );
    expect(accepted.listTypes[0]?.listsRewritten).toBe(3);
    const list = await getList(SYS, `${PFX}card-list`);
    expect(list.items[0]?.values).toEqual({ title: "A", badge: "new" });
    const rows = await asSystem(
      (tx) =>
        tx`
        SELECT (SELECT fields FROM modules WHERE id = ${moduleId}::uuid) AS fields,
               (SELECT "values" FROM content_instances WHERE id = ${ciId}::uuid) AS vals` as Promise<
          { fields: { default: ListItem[] }[]; vals: { cards: ListItem[] } }[]
        >,
    );
    expect(rows[0]?.fields[0]?.default[0]?.values).toEqual({ title: "L", badge: "new" });
    expect(rows[0]?.vals.cards[0]?.values).toEqual({ title: "C", badge: "new" });
    // Entry ids survive the rewrite.
    expect(rows[0]?.vals.cards[0]?.id).toBe(ciItem.id);

    // A type in use cannot be deleted.
    const inUse = await fail(SYS, "list_types.delete_many", { slugs: [slug] });
    expect(inUse).toContain("still in use");
  });

  it("needs content.structure: an operator without it is refused", async () => {
    const userId = crypto.randomUUID();
    await asSystem(async (tx) => {
      await tx`INSERT INTO actors (id, kind, display_name) VALUES (${userId}::uuid, 'human', 'reviewer')`;
      await tx`INSERT INTO users (id, email, password_hash) VALUES (${userId}::uuid, ${`${userId}@t1107.test`}, 'x')`;
      await tx`
        INSERT INTO user_roles (user_id, role_id)
        SELECT ${userId}::uuid, id FROM roles WHERE name = 'reviewer'`;
    });
    const human: ExecutionContext = { actorId: userId, actorKind: "human", requestId: "t1107-h" };
    const msg = await fail(human, "list_types.upsert_many", {
      listTypes: [
        {
          slug: `${PFX}denied`,
          name: "Denied",
          purpose: "test",
          role: "content",
          root: { allow: ["x"] },
          nodes: { x: { label: "X", fields: [] } },
        },
      ],
    });
    expect(msg).toContain("permission_denied");
    expect(msg).toContain("content.structure");
  });
});

describe("#1107 lists on the shared draft", () => {
  it("shows a chat's list to the other draft chat, not to main; a stale write is a conflict", async () => {
    const a = await chat("menu author");
    const b = await chat("menu reader");
    const slug = `${PFX}header-menu`;
    const created = await op<{ lists: { id: string; created: boolean; version: number }[] }>(
      a.ctx,
      "lists.upsert_many",
      {
        lists: [
          {
            slug,
            name: "Header menu",
            purpose: "The site header navigation.",
            type: "menu",
            items: menu(["Home", "About"]),
          },
        ],
      },
    );
    expect(created.lists[0]).toMatchObject({ created: true, version: 1 });
    // Draft chats share one branch: B sees A's list; main does not.
    expect((await getList(b.ctx, slug)).items.map((i) => i.values.label)).toEqual([
      "Home",
      "About",
    ]);
    expect(await fail(SYS, "lists.get", { slug })).toContain("no list");

    // A edits again; B's blind write conflicts, its re-read retry goes through.
    const aboutId = (await getList(a.ctx, slug)).items[1]?.id;
    await op(a.ctx, "lists.patch_items_many", {
      lists: [
        { slug, patches: [{ op: "update", itemId: aboutId, values: { label: "About us" } }] },
      ],
    });
    const stale = await fail(b.ctx, "lists.patch_items_many", {
      lists: [{ slug, patches: [{ op: "remove", itemId: aboutId }] }],
    });
    expect(stale).toContain("Conflict");
    expect(stale).toContain(`${PFX}menu author`);
    await op(b.ctx, "lists.patch_items_many", {
      lists: [
        {
          slug,
          patches: [
            { op: "add", parentId: aboutId, item: { node: "entry", values: { label: "Careers" } } },
          ],
        },
      ],
    });
    const seen = await getList(a.ctx, slug);
    expect(seen.items[1]?.values.label).toBe("About us");
    expect(seen.items[1]?.children?.[0]?.values.label).toBe("Careers");

    // expectedVersion against a stale version is a conflict too.
    const v = await fail(a.ctx, "lists.upsert_many", {
      lists: [
        { slug, name: "Header menu", purpose: "x", type: "menu", items: [], expectedVersion: 1 },
      ],
    });
    expect(v).toContain("Conflict");

    // Stage graduates the list created in the draft.
    await op(SYS, "chat.merge_draft_to_main", { chatSessionIds: [a.id, b.id] });
    const live = await getList(SYS, slug);
    expect(live.items[1]?.children?.[0]?.values.label).toBe("Careers");
    const row = await asSystem(
      (tx) =>
        tx`SELECT chat_branch_id FROM lists WHERE slug = ${slug}` as Promise<
          { chat_branch_id: string | null }[]
        >,
    );
    expect(row[0]?.chat_branch_id).toBeNull();
  });

  it("refuses entries that do not fit the type, naming the entry path", async () => {
    const msg = await fail(SYS, "lists.upsert_many", {
      lists: [
        {
          slug: `${PFX}bad-menu`,
          name: "Bad",
          purpose: "x",
          type: "menu",
          items: [{ node: "entry", values: { link: { href: "https://x.test/" } } }],
        },
      ],
    });
    expect(msg).toContain("items[0].values.label");
    expect(msg).toContain("rolled back");
  });

  it("undo of the chat restores the list; a revert restores a live list", async () => {
    const slug = `${PFX}footer`;
    await op(SYS, "lists.upsert_many", {
      lists: [
        {
          slug,
          name: "Footer",
          purpose: "footer links",
          type: "links",
          items: [
            {
              node: "link",
              values: { label: "Imprint", link: { href: "https://x.test/imprint" } },
            },
          ],
        },
      ],
    });
    const a = await chat("footer editor");
    await op(a.ctx, "lists.patch_items_many", {
      lists: [
        {
          slug,
          patches: [
            {
              op: "add",
              item: {
                node: "link",
                values: { label: "Privacy", link: { href: "https://x.test/privacy" } },
              },
            },
          ],
        },
      ],
    });
    expect((await getList(a.ctx, slug)).items).toHaveLength(2);
    expect((await getList(SYS, slug)).items).toHaveLength(1);
    await op(SYS, "chat.undo_changes", { chatSessionId: a.id });
    expect((await getList(a.ctx, slug)).items).toHaveLength(1);

    // Live write + revert_site of the first live snapshot.
    const first = await asSystem(
      (tx) =>
        tx`
        SELECT ss.id::text AS id FROM site_snapshots ss
        JOIN list_snapshots ls ON ls.site_snapshot_id = ss.id
        JOIN lists l ON l.id = ls.list_id
        WHERE l.slug = ${slug} AND ss.chat_branch_id IS NULL
        ORDER BY ss.created_at LIMIT 1` as Promise<{ id: string }[]>,
    );
    await op(SYS, "lists.upsert_many", {
      lists: [{ slug, name: "Footer", purpose: "footer links", type: "links", items: [] }],
    });
    expect((await getList(SYS, slug)).items).toHaveLength(0);
    await op(SYS, "snapshots.revert_site", { snapshotId: first[0]?.id });
    expect((await getList(SYS, slug)).items.map((i) => i.values.label)).toEqual(["Imprint"]);
  });

  it("refuses deleting a bound list, names the module, deletes it once unbound", async () => {
    const slug = `${PFX}bound`;
    const created = await op<{ lists: { id: string }[] }>(SYS, "lists.upsert_many", {
      lists: [{ slug, name: "Bound", purpose: "x", type: "links", items: [] }],
    });
    const listId = created.lists[0]?.id ?? "";
    const moduleId = crypto.randomUUID();
    await asSystem(
      (tx) => tx`
        INSERT INTO modules (id, slug, display_name, html, fields, type)
        VALUES (${moduleId}::uuid, ${`${PFX}nav`}, 'Nav', '<nav>{{#links}}{{label}}{{/links}}</nav>',
                (${JSON.stringify([
                  {
                    name: "links",
                    label: "Links",
                    kind: "list",
                    listType: "links",
                    bind: "shared",
                    list: `caelo:list/${listId}`,
                  },
                ])}::text)::jsonb, 'nav')`,
    );
    const usage = await op<{
      lists: { slug: string; usage: { modules: { slug: string; field: string }[] } }[];
    }>(SYS, "lists.list", { query: slug });
    expect(usage.lists.find((l) => l.slug === slug)?.usage.modules).toEqual([
      expect.objectContaining({ slug: `${PFX}nav`, field: "links" }),
    ]);
    const msg = await fail(SYS, "lists.delete_many", { slugs: [slug] });
    expect(msg).toContain(`"${PFX}nav" (field links)`);
    await asSystem(
      (tx) => tx`UPDATE modules SET fields = '[]'::jsonb WHERE id = ${moduleId}::uuid`,
    );
    expect(await op<{ deleted: string[] }>(SYS, "lists.delete_many", { slugs: [slug] })).toEqual({
      deleted: [slug],
    });
    expect(await fail(SYS, "lists.get", { slug })).toContain("no list");
    // Upserting the slug again revives the same entity.
    const again = await op<{ lists: { id: string }[] }>(SYS, "lists.upsert_many", {
      lists: [{ slug, name: "Bound", purpose: "x", type: "links", items: [] }],
    });
    expect(again.lists[0]?.id).toBe(listId);
  });

  it("promotes a module's local list to a shared list and rebinds the field", async () => {
    const moduleId = crypto.randomUUID();
    const items = [{ id: crypto.randomUUID(), node: "text", values: { text: "Fast" } }];
    await asSystem(async (tx) => {
      await tx`
        INSERT INTO modules (id, slug, display_name, html, fields, type)
        VALUES (${moduleId}::uuid, ${`${PFX}features`}, 'Features', '<ul>{{#bullets}}<li>{{text}}</li>{{/bullets}}</ul>',
                (${JSON.stringify([{ name: "bullets", label: "Bullets", kind: "list", listType: "texts", default: items }])}::text)::jsonb,
                'features')`;
      await tx`INSERT INTO content_instances (module_id, "values") VALUES (${moduleId}::uuid, (${JSON.stringify({ bullets: items })}::text)::jsonb)`;
      await tx`INSERT INTO content_instances (module_id, "values") VALUES (${moduleId}::uuid, '{}'::jsonb)`;
    });
    const r = await op<{ listId: string; listRef: string; itemCount: number }>(
      SYS,
      "lists.promote_local",
      {
        moduleId,
        field: "bullets",
        slug: `${PFX}feature-bullets`,
        name: "Feature bullets",
        purpose: "Shared feature bullets",
      },
    );
    expect(r.itemCount).toBe(1);
    const mod = await asSystem(
      (tx) =>
        tx`SELECT fields FROM modules WHERE id = ${moduleId}::uuid` as Promise<
          { fields: Record<string, unknown>[] }[]
        >,
    );
    expect(mod[0]?.fields[0]).toMatchObject({ bind: "shared", list: r.listRef });
    expect(mod[0]?.fields[0]).not.toHaveProperty("default");
    const cis = await asSystem(
      (tx) =>
        tx`SELECT "values" FROM content_instances WHERE module_id = ${moduleId}::uuid` as Promise<
          { values: Record<string, unknown> }[]
        >,
    );
    for (const c of cis) expect(c.values).not.toHaveProperty("bullets");
    expect((await getList(SYS, `${PFX}feature-bullets`)).items[0]?.id).toBe(items[0]?.id);

    // Placements that show different lists cannot be promoted into one.
    const other = crypto.randomUUID();
    await asSystem(async (tx) => {
      await tx`
        INSERT INTO modules (id, slug, display_name, html, fields, type)
        VALUES (${other}::uuid, ${`${PFX}chips`}, 'Chips', '<p>{{#chips}}{{text}}{{/chips}}</p>',
                (${JSON.stringify([{ name: "chips", label: "Chips", kind: "list", listType: "texts" }])}::text)::jsonb, 'chips')`;
      await tx`INSERT INTO content_instances (module_id, "values") VALUES (${other}::uuid, (${JSON.stringify({ chips: [{ id: crypto.randomUUID(), node: "text", values: { text: "a" } }] })}::text)::jsonb)`;
      await tx`INSERT INTO content_instances (module_id, "values") VALUES (${other}::uuid, (${JSON.stringify({ chips: [{ id: crypto.randomUUID(), node: "text", values: { text: "b" } }] })}::text)::jsonb)`;
    });
    const refused = await fail(SYS, "lists.promote_local", {
      moduleId: other,
      field: "chips",
      slug: `${PFX}chips-shared`,
      name: "Chips",
      purpose: "x",
    });
    expect(refused).toContain("different");
  });

  it("emits list.items_changed with the per-entry diff and the chat branch", async () => {
    const a = await chat("events");
    const slug = `${PFX}events-menu`;
    await op(a.ctx, "lists.upsert_many", {
      lists: [{ slug, name: "Events", purpose: "x", type: "menu", items: menu(["One"]) }],
    });
    const ev = await asSystem(
      (tx) =>
        tx`
        SELECT payload FROM domain_events
        WHERE kind = 'list.items_changed' AND payload->>'slug' = ${slug}
        ORDER BY id DESC LIMIT 1` as Promise<
          { payload: { changes: { kind: string }[]; chatBranchId: string } }[]
        >,
    );
    expect(ev[0]?.payload.chatBranchId).toBe(a.branch);
    expect(ev[0]?.payload.changes.map((c) => c.kind)).toEqual(["added"]);
  });

  it("validates list field values on module and content instance writes, assigning entry ids", async () => {
    const created = await op<{ moduleId: string }>(SYS, "modules.create", {
      slug: `${PFX}feature-list`,
      displayName: "Feature list",
      html: "<ul>{{#bullets}}<li>{{text}}</li>{{/bullets}}</ul>",
      fields: [
        {
          name: "bullets",
          label: "Bullets",
          kind: "list",
          listType: "texts",
          max: 2,
          default: [{ node: "text", values: { text: "Fast" } }],
        },
      ],
    });
    const mod = await asSystem(
      (tx) =>
        tx`SELECT fields FROM modules WHERE id = ${created.moduleId}::uuid` as Promise<
          { fields: { default: ListItem[] }[] }[]
        >,
    );
    expect(mod[0]?.fields[0]?.default[0]?.id).toMatch(/^[0-9a-f-]{36}$/);

    const ci = await op<{ contentInstanceId: string }>(SYS, "content_instances.create", {
      moduleId: created.moduleId,
      values: { bullets: [{ node: "text", values: { text: "One" } }] },
    });
    const stored = await asSystem(
      (tx) =>
        tx`SELECT "values" FROM content_instances WHERE id = ${ci.contentInstanceId}::uuid` as Promise<
          { values: { bullets: ListItem[] } }[]
        >,
    );
    expect(stored[0]?.values.bullets[0]?.id).toMatch(/^[0-9a-f-]{36}$/);

    const missing = await fail(SYS, "content_instances.create", {
      moduleId: created.moduleId,
      values: { bullets: [{ node: "text", values: {} }] },
    });
    expect(missing).toContain("values.bullets[0].values.text");
    const tooMany = await fail(SYS, "content_instances.set_values", {
      id: ci.contentInstanceId,
      values: {
        bullets: ["a", "b", "c"].map((text) => ({ node: "text", values: { text } })),
      },
    });
    expect(tooMany).toContain("at most 2");
  });
});
