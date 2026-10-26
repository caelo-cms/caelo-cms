// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { formatValueAddress, parseValueAddress } from "./address.js";
import { DEFAULT_LIST_TYPES } from "./default-types.js";
import { checkFieldDef, type FieldDef, validateFieldValue } from "./fields.js";
import {
  applyListItemPatches,
  diffListItems,
  findListItem,
  type ListItem,
  ListPatchError,
  validateListItems,
} from "./items.js";
import {
  checkListTypeDef,
  effectiveMaxDepth,
  hasRecursion,
  type ListTypeDef,
  listTypeDefSchema,
  sourceDefSchema,
} from "./list-type.js";
import { checkPageTypeDef, pageTypeDefSchema } from "./page-type.js";

const PAGE = "11111111-1111-4111-8111-111111111111";
const LIST = "22222222-2222-4222-8222-222222222222";
const ITEM = "33333333-3333-4333-8333-333333333333";

function ids(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  };
}

const MEGA: ListTypeDef = listTypeDefSchema.parse({
  slug: "main-menu",
  name: "Main menu",
  purpose: "Header navigation with mega panels",
  role: "navigation",
  root: { allow: ["entry"], max: 8 },
  nodes: {
    entry: {
      label: "Entry",
      fields: [
        { name: "label", label: "Label", type: "text", required: true },
        { name: "link", label: "Link", type: "link" },
        { name: "panel", label: "Panel", type: "select", options: ["none", "dropdown", "mega"] },
      ],
      children: { name: "columns", allow: ["column", "news_feed", "promo"], max: 4 },
      current_from: "link",
    },
    column: {
      label: "Column",
      fields: [{ name: "heading", label: "Heading", type: "text" }],
      children: { name: "links", allow: ["sub_link"], max: 12 },
    },
    sub_link: {
      label: "Sub link",
      fields: [
        { name: "label", label: "Label", type: "text", required: true },
        { name: "link", label: "Link", type: "link", required: true },
        { name: "icon", label: "Icon", type: "icon" },
      ],
      current_from: "link",
    },
    news_feed: {
      label: "Latest posts",
      fields: [{ name: "heading", label: "Heading", type: "text" }],
      source: {
        kind: "query",
        editable: ["page_type", "terms", "limit"],
        defaults: { page_type: "news", order: "published_desc", limit: 3 },
      },
    },
    promo: {
      label: "Teaser",
      fields: [{ name: "teaser", label: "Teaser", type: "module", accepts: ["promo-card"] }],
    },
  },
});

describe("field values", () => {
  const text: FieldDef = { name: "label", label: "Label", type: "text", required: true };
  it("requires required fields and accepts valid values", () => {
    expect(validateFieldValue(text, undefined, "p")).toHaveLength(1);
    expect(validateFieldValue(text, "  ", "p")).toHaveLength(1);
    expect(validateFieldValue(text, "Docs", "p")).toEqual([]);
  });
  it("checks every type's shape", () => {
    const cases: [FieldDef, unknown, boolean][] = [
      [{ name: "l", label: "L", type: "link" }, { href: "/about" }, true],
      [{ name: "l", label: "L", type: "link" }, "/about", false],
      [{ name: "m", label: "M", type: "media" }, `caelo:media/${PAGE}`, true],
      [{ name: "m", label: "M", type: "media" }, "/x.png", false],
      [{ name: "s", label: "S", type: "select", options: ["a", "b"] }, "b", true],
      [{ name: "s", label: "S", type: "select", options: ["a", "b"] }, "c", false],
      [{ name: "b", label: "B", type: "boolean" }, false, true],
      [{ name: "n", label: "N", type: "number", min: 1 }, 0, false],
      [{ name: "d", label: "D", type: "date" }, "2026-10-25", true],
      [{ name: "d", label: "D", type: "date" }, "25.10.2026", false],
      [{ name: "i", label: "I", type: "icon" }, "radar", true],
      [{ name: "t", label: "T", type: "term", list: "tags" }, [`caelo:term/${LIST}/${ITEM}`], true],
      [
        { name: "t", label: "T", type: "term", list: "tags" },
        [`caelo:term/${LIST}/${ITEM}`, `caelo:term/${LIST}/${PAGE}`],
        false,
      ],
    ];
    for (const [f, v, ok] of cases) {
      expect(validateFieldValue(f, v, "p").length === 0).toBe(ok);
    }
  });
  it("rejects reserved names and invalid defaults", () => {
    expect(checkFieldDef({ name: "is_open", label: "x", type: "boolean" }, "f")).toHaveLength(1);
    expect(checkFieldDef({ name: "depth", label: "x", type: "number" }, "f")).toHaveLength(1);
    expect(
      checkFieldDef({ name: "n", label: "x", type: "number", default: "1" }, "f"),
    ).toHaveLength(1);
  });
});

describe("list type definitions", () => {
  it("accepts the mega menu and every shipped type", () => {
    expect(checkListTypeDef(MEGA)).toEqual([]);
    for (const t of DEFAULT_LIST_TYPES)
      expect(checkListTypeDef(listTypeDefSchema.parse(t))).toEqual([]);
  });
  it("requires max_depth for recursive types", () => {
    const t = { ...DEFAULT_LIST_TYPES[2], max_depth: undefined } as ListTypeDef;
    expect(hasRecursion(t)).toBe(true);
    expect(checkListTypeDef(t).map((i) => i.path)).toContain("max_depth");
  });
  it("reports unknown node kinds, bad current_from, children+source", () => {
    const t: ListTypeDef = {
      ...MEGA,
      root: { allow: ["entry", "ghost"] },
      nodes: {
        ...MEGA.nodes,
        column: {
          ...MEGA.nodes.column!,
          current_from: "heading",
          source: { kind: "system", name: "breadcrumbs" },
        },
      },
    };
    const paths = checkListTypeDef(t).map((i) => i.path);
    expect(paths).toContain("root.allow");
    expect(paths).toContain("nodes.column.current_from");
    expect(paths).toContain("nodes.column");
  });
  it("requires name+slug on vocabulary entries", () => {
    const t: ListTypeDef = {
      slug: "v",
      name: "V",
      purpose: "p",
      role: "vocabulary",
      root: { allow: ["t"] },
      nodes: { t: { label: "T", fields: [{ name: "name", label: "N", type: "text" }] } },
    };
    expect(checkListTypeDef(t)).toHaveLength(1);
  });
  it("computes the effective depth", () => {
    expect(effectiveMaxDepth(MEGA)).toBe(3);
    expect(effectiveMaxDepth(listTypeDefSchema.parse(DEFAULT_LIST_TYPES[2]))).toBe(3);
  });
});

describe("list items", () => {
  const items = [
    {
      node: "entry",
      values: { label: "Products", link: { href: `caelo:page/${PAGE}` }, panel: "mega" },
      children: [
        {
          node: "column",
          values: { heading: "Platform" },
          children: [
            { node: "sub_link", values: { label: "Crawler", link: { href: "/crawler" } } },
          ],
        },
        { node: "news_feed", values: { heading: "New" }, query: { limit: 5 } },
      ],
    },
  ];

  it("validates a mega menu and assigns ids", () => {
    const r = validateListItems(MEGA, items, { newId: ids() });
    expect(r.issues).toEqual([]);
    expect(r.items[0]?.id).toBe("00000000-0000-4000-8000-000000000001");
    expect(r.items[0]?.children?.[0]?.children?.[0]?.values.label).toBe("Crawler");
  });

  it("reports misplaced nodes, missing fields, unknown values and query knobs", () => {
    const r = validateListItems(MEGA, [
      { node: "sub_link", values: { label: "x" } },
      {
        node: "entry",
        values: { label: "y", colour: "red" },
        children: [{ node: "news_feed", values: {}, query: { order: "title_asc" } }],
      },
    ]);
    const paths = r.issues.map((i) => i.path);
    expect(paths).toContain("items[0].node");
    expect(paths).toContain("items[0].values.link");
    expect(paths).toContain("items[1].values.colour");
    expect(paths).toContain("items[1].children[0].query.order");
  });

  it("enforces depth and per-level max", () => {
    const menu = listTypeDefSchema.parse(DEFAULT_LIST_TYPES[2]);
    const deep = {
      node: "entry",
      values: { label: "a" },
      children: [
        {
          node: "entry",
          values: { label: "b" },
          children: [
            {
              node: "entry",
              values: { label: "c" },
              children: [{ node: "entry", values: { label: "d" } }],
            },
          ],
        },
      ],
    };
    expect(validateListItems(menu, [deep]).issues.some((i) => i.message.includes("deeper"))).toBe(
      true,
    );
    const many = Array.from({ length: 9 }, (_, i) => ({
      node: "entry",
      values: { label: `e${i}` },
    }));
    expect(validateListItems(MEGA, many).issues.some((i) => i.message.includes("at most 8"))).toBe(
      true,
    );
  });

  it("patches by id and diffs", () => {
    const base = validateListItems(MEGA, items, { newId: ids() }).items;
    const entry = base[0] as ListItem;
    const column = entry.children?.[0] as ListItem;
    const next = applyListItemPatches(base, [
      { op: "update", itemId: entry.id, values: { label: "Platform" } },
      {
        op: "add",
        parentId: column.id,
        position: 0,
        item: { id: ITEM, node: "sub_link", values: { label: "API", link: { href: "/api" } } },
      },
      { op: "move", itemId: column.id, parentId: entry.id, position: 1 },
    ]);
    const validated = validateListItems(MEGA, next).items;
    expect(findListItem(validated, ITEM)?.values.label).toBe("API");
    const changes = diffListItems(base, validated);
    expect(changes).toContainEqual({ kind: "added", itemId: ITEM });
    expect(changes.find((c) => c.kind === "updated" && c.itemId === entry.id)).toBeDefined();
    expect(changes).toContainEqual({ kind: "moved", itemId: column.id });
  });

  it("refuses patches on unknown ids and moves into a child", () => {
    const base = validateListItems(MEGA, items, { newId: ids() }).items;
    const entry = base[0] as ListItem;
    const column = entry.children?.[0] as ListItem;
    expect(() => applyListItemPatches(base, [{ op: "remove", itemId: ITEM }])).toThrow(
      ListPatchError,
    );
    expect(() =>
      applyListItemPatches(base, [
        { op: "move", itemId: entry.id, parentId: column.id, position: 0 },
      ]),
    ).toThrow(ListPatchError);
  });
});

describe("page types and addresses", () => {
  it("checks the default template and module properties", () => {
    const t = pageTypeDefSchema.parse({
      slug: "news",
      name: "News",
      purpose: "Dated announcements",
      templates: [PAGE],
      defaultTemplate: LIST,
      properties: [{ name: "teaser", label: "T", type: "module" }],
    });
    expect(checkPageTypeDef(t).map((i) => i.path)).toEqual(["defaultTemplate", "properties[0]"]);
  });
  it("round-trips addresses", () => {
    for (const s of [
      `list/${LIST}/item/${ITEM}/label`,
      `instance/${LIST}/features/item/${ITEM}/text`,
      `page/${PAGE}/props/author`,
      `list_type/${LIST}/node/entry/label`,
    ]) {
      const a = parseValueAddress(s);
      expect(a).not.toBeNull();
      expect(formatValueAddress(a!)).toBe(s);
    }
    expect(parseValueAddress("pages/x")).toBeNull();
  });
});

describe("source definitions", () => {
  it("a plugin source written as a system source is refused with the plugin form (PR #1121 e2e)", () => {
    const r = sourceDefSchema.safeParse({ kind: "system", name: "consent_categories" });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toContain('{kind:"plugin", name:"<source>"}');
    expect(sourceDefSchema.safeParse({ kind: "plugin", name: "consent_categories" }).success).toBe(
      true,
    );
  });
});
