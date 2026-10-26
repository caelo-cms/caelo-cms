// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 — the list / list type / page type tools (docs/lists.md §12):
 * each forwards its input to the op unchanged, renders a result the AI can
 * act on (entry ids, list refs, compact type definitions), and translates
 * the ops' op-name hints into tool names. Stub ops; the ops themselves are
 * covered against Postgres in ops/lists tests.
 */

import { describe, expect, it } from "bun:test";
import {
  type DatabaseAdapter,
  defineOperation,
  type OperationDefinition,
  OperationRegistry,
} from "@caelo-cms/query-api";
import { DEFAULT_LIST_TYPES, type ExecutionContext, ok } from "@caelo-cms/shared";
import { z } from "zod";
import { LIST_FIELD_CONTRACT, LISTS_ALIAS, toolNamesIn } from "../_list-tool-kit.js";
import { buildPageTool } from "../build-page.js";
import { updatePagesManyTool } from "../bulk-pages-modules.js";
import { createTemplateTool } from "../create-template.js";
import type { ToolContext } from "../dispatch.js";
import { createDefaultToolRegistry } from "../index.js";
import { catalogField } from "../list-modules.js";
import {
  getListTool,
  listListsTool,
  patchListItemsManyTool,
  previewListSourceTool,
  upsertListsManyTool,
} from "../list-tools.js";
import { listListTypesTool, upsertListTypesManyTool } from "../list-type-tools.js";
import { listPageTypesTool } from "../page-type-tools.js";

const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-0000000000a1",
  actorKind: "ai",
  requestId: "list-tools-test",
};
const NEWS_ENTRY = "33333333-3333-4333-8333-333333333333";
const LIST_ID = "6f1f2d3a-4b5c-4d6e-8f70-112233445566";
const COMPANY = "0a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";

/** Stub ops answering `values[name]` (or an error) and recording each input. */
function harness(values: Record<string, unknown>, errors: Record<string, string> = {}) {
  const calls: { op: string; input: unknown }[] = [];
  const registry = new OperationRegistry();
  for (const name of [...Object.keys(values), ...Object.keys(errors)]) {
    registry.register(
      defineOperation({
        name,
        actorScope: ["human", "ai", "system"],
        database: "cms_admin",
        input: z.any(),
        output: z.any(),
        handler: async (_ctx, input) => {
          calls.push({ op: name, input });
          if (name in errors) {
            return {
              ok: false,
              error: { kind: "HandlerError", operation: name, message: errors[name] },
            } as never;
          }
          return ok(values[name]) as never;
        },
      }),
    );
  }
  const adapter = {
    runOperation: (op: OperationDefinition, ctx: ExecutionContext, input: unknown) =>
      op.handler(ctx, input, {} as never),
  } as unknown as DatabaseAdapter;
  return { toolCtx: { adapter, registry } as ToolContext, calls };
}

const usage = {
  modules: [{ moduleId: "m", slug: "site-header", displayName: "Header", field: "nav" }],
  placementCount: 1,
  samplePages: [{ pageId: "p", path: "/", title: "Home" }],
  pageTypes: [],
  taggedPageCount: 0,
};

describe("list tools (epic #1107)", () => {
  it("every list tool is registered and says menus are shared lists where the AI decides", () => {
    const names = new Set(
      createDefaultToolRegistry()
        .catalogue()
        .map((t) => t.name),
    );
    for (const n of [
      "list_list_types",
      "upsert_list_types_many",
      "delete_list_types_many",
      "list_lists",
      "get_list",
      "upsert_lists_many",
      "patch_list_items_many",
      "delete_lists_many",
      "promote_local_list",
      "preview_list_source",
      "list_page_types",
      "upsert_page_types_many",
      "delete_page_types_many",
    ]) {
      expect(names.has(n)).toBe(true);
    }
    expect(LISTS_ALIAS).toContain(
      "Menus, navigation, footer links, categories and tags are SHARED LISTS",
    );
    // Said once, where the AI looks for a menu (catalogue budget below).
    expect(listListsTool.description).toContain(LISTS_ALIAS);
    expect(LIST_FIELD_CONTRACT).toContain("promote_local_list");
  });

  it("list_lists renders usage so the AI finds the header's menu instead of minting one", async () => {
    const { toolCtx } = harness({
      "lists.list": {
        lists: [
          {
            id: LIST_ID,
            slug: "main-nav",
            name: "Main navigation",
            purpose: "Header menu",
            type: "menu",
            role: "navigation",
            itemCount: 4,
            version: 2,
            updatedAt: "2026-10-25T10:00:00Z",
            usage,
          },
        ],
      },
    });
    const r = await listListsTool.handler(AI, {} as never, toolCtx);
    expect(r.ok).toBe(true);
    expect(r.content).toContain("main-nav");
    expect(r.content).toContain("site-header.nav");
  });

  it("get_list renders the entry tree with ids, so patches can address entries", async () => {
    const { toolCtx } = harness({
      "lists.get": {
        list: {
          id: LIST_ID,
          slug: "main-nav",
          name: "Main navigation",
          purpose: "Header menu",
          type: "menu",
          role: "navigation",
          itemCount: 2,
          version: 3,
          updatedAt: "2026-10-25T10:00:00Z",
          usage,
          items: [
            {
              id: COMPANY,
              node: "entry",
              values: { label: "Company", link: { href: "/about" } },
              children: [
                {
                  id: "11111111-2222-4333-8444-555555555555",
                  node: "entry",
                  values: { label: "Team" },
                },
              ],
            },
          ],
        },
      },
    });
    const r = await getListTool.handler(AI, { slug: "main-nav" }, toolCtx);
    expect(r.ok).toBe(true);
    expect(r.content).toContain("version 3");
    expect(r.content).toContain(
      `- [${COMPANY}] entry {"label":"Company","link":{"href":"/about"}}`,
    );
    expect(r.content).toContain(
      '  - [11111111-2222-4333-8444-555555555555] entry {"label":"Team"}',
    );
    // The read names the tree with the key the write takes, and the role
    // as the type's (v0.11.0 release gate: an "entries:" heading and the
    // role were copied into an upsert_lists_many call).
    expect(r.content).toContain("\nitems:\n");
    expect(r.content).not.toContain("entries:");
    expect(r.content).toContain("set by the type");
    expect(upsertListsManyTool.description).toContain("not `entries`");
  });

  it("patch_list_items_many forwards the patches unchanged and names the added ids", async () => {
    const { toolCtx, calls } = harness({
      "lists.patch_items_many": {
        lists: [{ id: LIST_ID, slug: "main-nav", version: 4, addedItemIds: ["new-id"] }],
      },
    });
    const input = {
      lists: [
        {
          slug: "main-nav",
          expectedVersion: 3,
          patches: [
            {
              op: "add" as const,
              parentId: COMPANY,
              item: { node: "entry", values: { label: "Careers", link: { href: "/careers" } } },
            },
          ],
        },
      ],
    };
    expect(patchListItemsManyTool.schema.safeParse(input).success).toBe(true);
    const r = await patchListItemsManyTool.handler(AI, input as never, toolCtx);
    expect(calls).toEqual([{ op: "lists.patch_items_many", input }]);
    expect(r.content).toContain("added entry ids: new-id");
  });

  // e2e-livedit run 40347740757: the AI sent page_type + order in a mega
  // menu's news entry `query`, which only takes the source's editable knobs
  // (the type's defaults fix the rest) — the description now says so.
  it("upsert_lists_many says an entry query takes only the editable knobs", () => {
    expect(upsertListsManyTool.description).toContain(
      "only with the knobs that node's source lists in `editable`",
    );
    expect(upsertListsManyTool.description).toContain("fixed by the type's `defaults`");
  });

  it("upsert_lists_many accepts a nested entry tree and returns the list ref for binding", async () => {
    const { toolCtx } = harness({
      "lists.upsert_many": {
        lists: [
          {
            id: LIST_ID,
            slug: "footer-links",
            version: 1,
            created: true,
            itemCount: 2,
            sourceEntries: [{ id: NEWS_ENTRY, node: "news" }],
          },
        ],
      },
    });
    const input = {
      lists: [
        {
          slug: "footer-links",
          name: "Footer links",
          purpose: "Legal links in the footer",
          type: "menu",
          items: [
            {
              node: "entry",
              values: { label: "Legal" },
              children: [
                { node: "entry", values: { label: "Imprint", link: { href: "/imprint" } } },
              ],
            },
          ],
        },
      ],
    };
    expect(upsertListsManyTool.schema.safeParse(input).success).toBe(true);
    const r = await upsertListsManyTool.handler(AI, input as never, toolCtx);
    expect(r.content).toContain(`ref=caelo:list/${LIST_ID}`);
    // The ids preview_list_source takes are in the result (PR #1121 e2e).
    expect(r.content).toContain(
      `source entries (preview_list_source itemId): ${NEWS_ENTRY} (news)`,
    );
  });

  it("the list tools stay within their catalogue budget", () => {
    // Every catalogue tool — deferred ones too — counts toward each chat
    // call's input. The lists epic first added ~45k characters and pushed
    // the real-AI homepage scenario over its input ceiling (PR #1143).
    const names = new Set([
      "list_list_types",
      "upsert_list_types_many",
      "delete_list_types_many",
      "list_lists",
      "get_list",
      "upsert_lists_many",
      "patch_list_items_many",
      "delete_lists_many",
      "promote_local_list",
      "preview_list_source",
      "list_page_types",
      "upsert_page_types_many",
      "delete_page_types_many",
    ]);
    const size = createDefaultToolRegistry()
      .catalogue()
      .filter((t) => names.has(t.name))
      .reduce(
        (n, t) => n + t.name.length + t.description.length + JSON.stringify(t.inputSchema).length,
        0,
      );
    expect(size).toBeLessThanOrEqual(18_000);
  });

  it("op-name hints come back as tool names", async () => {
    expect(toolNamesIn("create it with lists.upsert_many; list_types.get shows the fields")).toBe(
      "create it with upsert_lists_many; list_list_types (with slug) shows the fields",
    );
    const { toolCtx } = harness(
      {},
      { "lists.upsert_many": 'no list type "mega" — create the type with list_types.upsert_many.' },
    );
    const r = await upsertListsManyTool.handler(
      AI,
      { lists: [{ slug: "x", name: "x", purpose: "x", type: "mega", items: [] }] } as never,
      toolCtx,
    );
    expect(r.ok).toBe(false);
    expect(r.content).toContain("upsert_lists_many failed");
    expect(r.content).toContain("create the type with upsert_list_types_many");
  });

  it("list_list_types shows node fields compactly; slug reads the detail op", async () => {
    const menu = DEFAULT_LIST_TYPES.find((t) => t.slug === "menu");
    const { toolCtx, calls } = harness({
      "list_types.list": {
        listTypes: [
          {
            slug: "menu",
            definition: menu,
            listCount: 1,
            version: 1,
            ownerPlugin: null,
            inertExt: [],
          },
          {
            slug: "language-switcher",
            definition: { ...menu, slug: "language-switcher" },
            listCount: 0,
            version: 1,
            ownerPlugin: "international-site",
            inertExt: ["nodes.entry.ext.seo-plugin"],
          },
        ],
      },
      "list_types.get": {
        listType: {
          slug: "menu",
          definition: menu,
          listCount: 1,
          version: 1,
          ownerPlugin: null,
          inertExt: [],
        },
        lists: [{ id: LIST_ID, slug: "main-nav", name: "Main navigation" }],
        localLists: [],
      },
    });
    const all = await listListTypesTool.handler(AI, {}, toolCtx);
    expect(all.content).toContain("menu (navigation)");
    expect(all.content).toContain('node entry "');
    expect(all.content).toContain("label*:text");
    expect(all.content).toContain('children "children" → entry');
    // A plugin-owned type says it is read-only; inert extensions are named.
    expect(all.content).toContain('ships with plugin "international-site" (read-only definition');
    expect(all.content).toContain("inert plugin settings: nodes.entry.ext.seo-plugin");
    const one = await listListTypesTool.handler(AI, { slug: "menu" }, toolCtx);
    expect(one.content).toContain('main-nav ("Main navigation")');
    expect(calls.map((c) => c.op)).toEqual(["list_types.list", "list_types.get"]);
  });

  it("upsert_list_types_many takes a mega menu with a query-source node", () => {
    const mega = {
      slug: "mega-menu",
      name: "Mega menu",
      purpose: "Header navigation with columns and the latest news",
      role: "navigation",
      root: { allow: ["column"] },
      nodes: {
        column: {
          label: "Column",
          fields: [{ name: "heading", type: "text", label: "Heading", required: true }],
          children: { name: "links", allow: ["link", "news"] },
        },
        link: {
          label: "Link",
          fields: [
            { name: "label", type: "text", label: "Label", required: true },
            { name: "link", type: "link", label: "Link", required: true },
          ],
          current_from: "link",
        },
        news: {
          label: "Latest news",
          fields: [{ name: "heading", type: "text", label: "Heading" }],
          source: {
            kind: "query",
            editable: ["limit"],
            defaults: { page_type: "news", order: "published_desc", limit: 3 },
          },
        },
      },
    };
    expect(upsertListTypesManyTool.schema.safeParse({ listTypes: [mega] }).success).toBe(true);
  });

  it("preview_list_source takes exactly one way of naming the source", () => {
    const s = previewListSourceTool.schema;
    expect(
      s.safeParse({ source: { kind: "system", name: "breadcrumbs" }, pageId: COMPANY }).success,
    ).toBe(true);
    expect(s.safeParse({ list: "mega", itemId: COMPANY }).success).toBe(true);
    expect(s.safeParse({ list: "mega", node: "news", value: { limit: 2 } }).success).toBe(true);
    expect(s.safeParse({ list: "mega", node: "news", itemId: COMPANY }).success).toBe(false);
    expect(
      s.safeParse({ list: "mega", itemId: COMPANY, source: { kind: "system", name: "children" } })
        .success,
    ).toBe(false);
    expect(s.safeParse({ list: "mega" }).success).toBe(false);
  });

  it("list_page_types renders properties and vocabularies", async () => {
    const { toolCtx } = harness({
      "page_types.list": {
        pageTypes: [
          {
            id: "pt",
            slug: "news",
            name: "News",
            purpose: "Articles",
            templates: ["t1"],
            defaultTemplate: "t1",
            properties: [{ name: "author", type: "text", label: "Author", required: true }],
            vocabularies: [{ list: LIST_ID, cardinality: "many" }],
            version: 1,
            updatedAt: "x",
            pageCount: 3,
            vocabularySlugs: ["categories"],
          },
        ],
      },
    });
    const r = await listPageTypesTool.handler(AI, {}, toolCtx);
    expect(r.content).toContain("news — News: Articles");
    expect(r.content).toContain("properties: author*:text");
    expect(r.content).toContain(`categories (many, list ${LIST_ID})`);
  });

  it("list_modules shows a list field's type and binding", () => {
    expect(
      catalogField(
        {
          name: "nav",
          kind: "list",
          listType: "menu",
          bind: "shared",
          list: `caelo:list/${LIST_ID}`,
        },
        (ref) => (ref === `caelo:list/${LIST_ID}` ? "main-nav" : ref),
      ),
    ).toBe("nav:list(menu) shared=main-nav");
    expect(catalogField({ name: "items", kind: "list", listType: "texts" })).toBe(
      "items:list(texts) local",
    );
    expect(
      catalogField({
        name: "latest",
        kind: "list",
        listType: "links",
        bind: "source",
        source: { kind: "query", defaults: { page_type: "news", limit: 3 } },
      }),
    ).toBe("latest:list(links) source=query(page_type=news limit=3)");
  });

  it("page tools take what a page IS: pageType, properties, terms", () => {
    const term = `caelo:term/${LIST_ID}/${COMPANY}`;
    expect(
      updatePagesManyTool.schema.safeParse({
        updates: [
          { pageId: COMPANY, pageType: "news", properties: { author: "Ada" }, terms: [term] },
        ],
      }).success,
    ).toBe(true);
    expect(
      buildPageTool.schema.safeParse({
        page: { slug: "launch", title: "Launch", pageType: "news", terms: [term] },
        modules: [],
      }).success,
    ).toBe(true);
    expect(
      createTemplateTool.schema.safeParse({
        slug: "news-article",
        displayName: "News article",
        html: '<main><caelo-slot name="content"></caelo-slot></main>',
        pageType: "news",
      }).success,
    ).toBe(true);
    const json = JSON.stringify(updatePagesManyTool.inputSchema);
    expect(json).toContain('"pageType"');
    expect(json).toContain('"terms"');
  });
});
