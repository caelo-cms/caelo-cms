// SPDX-License-Identifier: MPL-2.0
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LIST_TYPES,
  type FieldDef,
  LIST_FIELD_TYPES,
  type ListTypeDef,
} from "@caelo-cms/shared";
import { activeListTab, LIST_EDITOR_TABS, listEditorTabs } from "./editor-tabs.js";
import {
  cleanValues,
  coerceFieldValue,
  entrySummary,
  fieldInputSpec,
  fieldProblems,
  initialValues,
} from "./field-form.js";
import { editableKnobs, effectiveQuery, setKnob } from "./query-knobs.js";
import {
  contentModeOf,
  listTypeIssues,
  needsDropValues,
  newField,
  newNode,
  removeNode,
  renameNode,
  snakeName,
  uniqueName,
  withContentMode,
  withFieldType,
} from "./type-editor.js";

const MENU = DEFAULT_LIST_TYPES.find((t) => t.slug === "menu") as ListTypeDef;

describe("form generation", () => {
  test("every field type maps to its own widget", () => {
    const widgets = LIST_FIELD_TYPES.map((type) => {
      const field = withFieldType({ name: "f", label: "F", type: "text" }, type, {
        vocabularySlugs: ["tags"],
      });
      return fieldInputSpec(field).widget;
    });
    expect(widgets).toEqual([...LIST_FIELD_TYPES]);
  });

  test("specs carry the type's attributes", () => {
    expect(fieldInputSpec({ name: "t", label: "T", type: "text", required: true })).toMatchObject({
      widget: "text",
      required: true,
      maxLength: 500,
    });
    expect(fieldInputSpec({ name: "n", label: "N", type: "number", min: 1, max: 9 })).toMatchObject(
      { min: 1, max: 9 },
    );
    expect(
      fieldInputSpec({ name: "c", label: "C", type: "term", list: "tags", multiple: true }),
    ).toMatchObject({ widget: "term", vocabulary: "tags", multiple: true });
    expect(fieldInputSpec({ name: "m", label: "M", type: "module" }).accepts).toEqual([]);
  });

  test("initial values are the defaults only", () => {
    const fields: FieldDef[] = [
      { name: "a", label: "A", type: "text" },
      { name: "b", label: "B", type: "boolean", default: true },
    ];
    expect(initialValues(fields)).toEqual({ b: true });
  });

  test("coercion: numbers parsed, empty inputs unset, links trimmed", () => {
    const num: FieldDef = { name: "n", label: "N", type: "number" };
    expect(coerceFieldValue(num, "12")).toBe(12);
    expect(coerceFieldValue(num, "")).toBeUndefined();
    const link: FieldDef = { name: "l", label: "L", type: "link" };
    expect(coerceFieldValue(link, { href: " /about ", target: "_self" })).toEqual({
      href: "/about",
    });
    expect(coerceFieldValue(link, { href: "" })).toBeUndefined();
    expect(coerceFieldValue(link, { href: "https://x.test", target: "_blank" })).toEqual({
      href: "https://x.test",
      target: "_blank",
    });
    const fields: FieldDef[] = [
      { name: "label", label: "L", type: "text" },
      { name: "link", label: "Link", type: "link" },
    ];
    expect(cleanValues(fields, { label: "", link: { href: "/x" }, stray: 1 })).toEqual({
      link: { href: "/x" },
    });
  });

  test("inline problems mirror the server's value check", () => {
    const req: FieldDef = { name: "label", label: "Label", type: "text", required: true };
    expect(fieldProblems(req, "")).toEqual(["Required."]);
    expect(fieldProblems(req, "ok")).toEqual([]);
    const media: FieldDef = { name: "img", label: "Image", type: "media" };
    expect(fieldProblems(media, "/_caelo/media/hero")).toEqual([]);
  });

  test("tree rows read the first text value, then the link", () => {
    expect(entrySummary(MENU, "entry", { label: "About", link: { href: "/about" } })).toBe("About");
    expect(entrySummary(MENU, "entry", { link: { href: "/about" } })).toBe("/about");
    expect(entrySummary(MENU, "entry", {})).toBe(MENU.nodes.entry?.label ?? "");
  });
});

describe("type editing", () => {
  test("names", () => {
    expect(snakeName("Main link")).toBe("main_link");
    expect(snakeName("123")).toBe("field");
    expect(uniqueName("label", ["label", "label_2"])).toBe("label_3");
    expect(newField([{ name: "new_field", label: "x", type: "text" }]).name).toBe("new_field_2");
  });

  test("retyping keeps identity, drops the old type's attributes and default", () => {
    const f: FieldDef = { name: "x", label: "X", type: "text", maxLength: 20, default: "a" };
    expect(withFieldType(f, "select", { vocabularySlugs: [] })).toEqual({
      name: "x",
      label: "X",
      type: "select",
      options: ["option_a"],
    });
    expect(withFieldType(f, "term", { vocabularySlugs: ["categories"] })).toMatchObject({
      list: "categories",
    });
  });

  test("rename and remove a node kind follow every allow", () => {
    const renamed = renameNode(MENU, "entry", "item");
    expect(renamed.root.allow).toEqual(["item"]);
    expect(renamed.nodes.item?.children?.allow).toEqual(["item"]);
    expect(listTypeIssues(renamed)).toEqual([]);
    const { kind, node } = newNode(MENU, "Column");
    const withColumn = { ...MENU, nodes: { ...MENU.nodes, [kind]: node } };
    const removed = removeNode(withColumn, "entry");
    expect(Object.keys(removed.nodes)).toEqual(["column"]);
    // root.allow is now empty: the checker says so instead of saving a broken type.
    expect(listTypeIssues(removed).length).toBeGreaterThan(0);
  });

  test("a node has children or a source, never both", () => {
    const node = MENU.nodes.entry as NonNullable<ListTypeDef["nodes"][string]>;
    expect(contentModeOf(node)).toBe("children");
    const q = withContentMode(node, "query", "entry");
    expect(q.children).toBeUndefined();
    expect(contentModeOf(q)).toBe("query");
    expect(contentModeOf(withContentMode(q, "none", "entry"))).toBe("none");
  });

  test("a missing max_depth on a recursive type is reported", () => {
    const { max_depth: _drop, ...noDepth } = MENU;
    expect(listTypeIssues(noDepth).map((i) => i.path)).toContain("max_depth");
  });

  test("drop-values refusals are recognised", () => {
    expect(needsDropValues("… or resend with dropValues: true to delete the values")).toBe(true);
    expect(needsDropValues("Conflict: list type is at version 3")).toBe(false);
  });
});

describe("query knobs", () => {
  const source = {
    kind: "query" as const,
    editable: ["limit", "page_type"] as ("limit" | "page_type")[],
    defaults: { order: "published_desc" as const, limit: 3 },
  };

  test("only editable knobs, defaults merged", () => {
    expect(editableKnobs(source)).toEqual(["limit", "page_type"]);
    expect(editableKnobs({ kind: "system", name: "children" })).toEqual([]);
    expect(effectiveQuery(source, { limit: 5, order: "title_asc" })).toEqual({
      order: "published_desc",
      limit: 5,
    });
  });

  test("an override equal to the default, empty or not editable is not stored", () => {
    expect(setKnob(source, {}, "limit", 7)).toEqual({ limit: 7 });
    expect(setKnob(source, { limit: 7 }, "limit", 3)).toEqual({});
    expect(setKnob(source, { page_type: "news" }, "page_type", "")).toEqual({});
    expect(setKnob(source, {}, "order", "title_asc")).toEqual({});
  });
});

describe("editor tabs", () => {
  test("plugin tabs show only while their plugin is active", () => {
    // The Languages tab is international-site's (epic #1107 part G).
    const tabs = LIST_EDITOR_TABS;
    expect(listEditorTabs("main-menu", new Set(), tabs).map((t) => t.id)).toEqual([
      "",
      "structure",
    ]);
    expect(
      listEditorTabs("main-menu", new Set(["international-site"]), tabs).map((t) => t.href),
    ).toEqual([
      "/content/lists/main-menu",
      "/content/lists/main-menu/structure",
      "/content/lists/main-menu/languages",
    ]);
  });

  test("active tab from the path", () => {
    expect(activeListTab("/content/lists/main-menu", "main-menu")).toBe("");
    expect(activeListTab("/content/lists/main-menu/structure", "main-menu")).toBe("structure");
  });
});

describe("used in", () => {
  test("names sections and page counts, or says it is unused", async () => {
    const { usageSummary } = await import("./usage.js");
    expect(
      usageSummary({
        modules: [{ displayName: "Header" }, { displayName: "Footer" }, { displayName: "Sidebar" }],
        placementCount: 12,
        samplePages: [],
        taggedPageCount: 0,
      }),
    ).toBe("Header, Footer +1 on 12 pages");
    expect(
      usageSummary({ modules: [], placementCount: 0, samplePages: [], taggedPageCount: 1 }),
    ).toBe("1 page tagged");
    expect(
      usageSummary({ modules: [], placementCount: 0, samplePages: [], taggedPageCount: 0 }),
    ).toBe("Not used yet");
  });
});

describe("term choices", () => {
  test("flatten a vocabulary depth-first with term references", async () => {
    const { termChoices } = await import("./field-context.js");
    const choices = termChoices({
      id: "11111111-1111-4111-8111-111111111111",
      slug: "categories",
      name: "Categories",
      items: [
        {
          id: "a",
          node: "category",
          values: { name: "Guides" },
          children: [{ id: "b", node: "category", values: { name: "Setup" } }],
        },
      ],
    });
    expect(choices).toEqual([
      { ref: "caelo:term/11111111-1111-4111-8111-111111111111/a", name: "Guides", depth: 1 },
      { ref: "caelo:term/11111111-1111-4111-8111-111111111111/b", name: "Setup", depth: 2 },
    ]);
  });
});

describe("page settings payload", () => {
  test("cleans properties, clears dropped ones, keeps only the type's terms", async () => {
    const { pageSettingsPayload } = await import("./page-settings.js");
    const VOCAB = "22222222-2222-4222-8222-222222222222";
    const OTHER = "33333333-3333-4333-8333-333333333333";
    const ITEM = "44444444-4444-4444-8444-444444444444";
    const out = pageSettingsPayload(
      {
        properties: [
          { name: "author", label: "Author", type: "text" },
          { name: "rating", label: "Rating", type: "number" },
        ],
        vocabularies: [{ list: VOCAB, cardinality: "many" }],
      },
      {
        properties: { author: "Ann", rating: "" },
        terms: [
          `caelo:term/${VOCAB}/${ITEM}`,
          `caelo:term/${OTHER}/${ITEM}`,
          `caelo:term/${VOCAB}/${ITEM}`,
        ],
      },
      { properties: { rating: 3, legacy: "x" } },
    );
    expect(out).toEqual({
      properties: { author: "Ann", rating: null, legacy: null },
      terms: [`caelo:term/${VOCAB}/${ITEM}`],
    });
  });
});
