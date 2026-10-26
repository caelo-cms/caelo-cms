// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 part G — the pure list-translation model: units, overlays,
 * findings and reconciliation, one test per row of the change-handling
 * table (README "Lists").
 */

import { describe, expect, it } from "bun:test";
import type { ListItem, ListTypeDef } from "@caelo-cms/plugin-sdk";
import {
  collectSources,
  findingsFor,
  indexKey,
  isTranslatableField,
  type ListSourceSnapshot,
  overlayFor,
  type ReconcileRow,
  reconcile,
  type StoredTranslation,
  textHash,
  unitStatus,
} from "./list-translation.js";

const LIST = "11111111-1111-4111-8111-111111111111";
const VOCAB = "22222222-2222-4222-8222-222222222222";
const CI = "33333333-3333-4333-8333-333333333333";
const PAGE = "44444444-4444-4444-8444-444444444444";
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "aaaaaaaa-0000-4000-8000-000000000002";
const C = "aaaaaaaa-0000-4000-8000-000000000003";
const T1 = "bbbbbbbb-0000-4000-8000-000000000001";

const menu: ListTypeDef = {
  slug: "menu",
  name: "Menu",
  purpose: "Navigation",
  role: "navigation",
  root: { allow: ["entry"] },
  nodes: {
    entry: {
      label: "Entry",
      fields: [
        { name: "label", label: "Label", type: "text", required: true },
        { name: "hint", label: "Hint", type: "text" },
        {
          name: "sku",
          label: "Code",
          type: "text",
          ext: { "international-site": { translate: false } },
        },
        { name: "link", label: "Link", type: "link" },
      ],
      children: { name: "children", allow: ["entry"] },
    },
  },
  max_depth: 3,
};
const tags: ListTypeDef = {
  slug: "tags",
  name: "Tags",
  purpose: "Tags",
  role: "vocabulary",
  root: { allow: ["tag"] },
  nodes: {
    tag: {
      label: "Tag",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "slug", label: "Slug", type: "text", required: true },
      ],
    },
  },
};
const types = new Map([
  ["menu", menu],
  ["tags", tags],
]);

function entry(id: string, values: Record<string, unknown>, children?: ListItem[]): ListItem {
  return { id, node: "entry", values, ...(children ? { children } : {}) };
}

function snapshot(items: ListItem[], extra: { instance?: ListItem[]; props?: string } = {}) {
  return collectSources({
    listTypes: types,
    lists: [
      { id: LIST, slug: "main", name: "Main menu", type: "menu", items },
      {
        id: VOCAB,
        slug: "tags",
        name: "Tags",
        type: "tags",
        items: [{ id: T1, node: "tag", values: { name: "News", slug: "news" } }],
      },
    ],
    instances: extra.instance
      ? [
          {
            id: CI,
            label: "Footer",
            listFields: [{ name: "links", listType: "menu" }],
            values: { links: extra.instance },
            locales: new Set(["de"]),
          },
        ]
      : [],
    pageProps:
      extra.props !== undefined
        ? [
            {
              pageId: PAGE,
              label: "Preise",
              locale: "de",
              properties: [{ name: "subtitle", label: "Subtitle", type: "text" }],
              source: { subtitle: extra.props },
            },
          ]
        : [],
  });
}

const addr = (item: string, field: string) => `list/${LIST}/item/${item}/${field}`;
const entryAddr = (item: string) => `list/${LIST}/item/${item}`;

function index(rows: Record<string, StoredTranslation>): Map<string, StoredTranslation> {
  return new Map(Object.entries(rows).map(([k, v]) => [indexKey("de", k), v]));
}

const allLinksOk = () => true;
const none = new Set<string>();

function overlay(s: ListSourceSnapshot, idx: Map<string, StoredTranslation>, links = allLinksOk) {
  return overlayFor(s, "de", idx, links, none);
}

describe("the translate attribute", () => {
  it("defaults text and rich text to translated; an explicit false and other types stay as they are", () => {
    const f = menu.nodes.entry?.fields ?? [];
    expect(f.map((x) => [x.name, isTranslatableField(x)])).toEqual([
      ["label", true],
      ["hint", true],
      ["sku", false],
      ["link", false],
    ]);
  });
});

describe("change handling", () => {
  const items = [
    entry(A, { label: "Pricing", hint: "Plans", sku: "P-1", link: { href: "/pricing" } }),
  ];

  it("added entry → missing; the entry is hidden until its required text exists", () => {
    const s = snapshot(items);
    const u = s.units.find((x) => x.address === addr(A, "label"));
    expect(u && unitStatus(u, "de", index({}))).toBe("missing");
    const o = overlay(s, index({}));
    expect(o.hidden).toContain(entryAddr(A));
  });

  it("a missing optional text renders empty, never in the source language", () => {
    const s = snapshot(items);
    const o = overlay(
      s,
      index({ [addr(A, "label")]: { value: "Preise", hash: textHash("Pricing") } }),
    );
    expect(o.hidden).not.toContain(entryAddr(A));
    expect(o.values[addr(A, "label")]).toBe("Preise");
    expect(o.values[addr(A, "hint")]).toBe("");
    // translate: false — the stored value renders, nothing is overlaid.
    expect(Object.hasOwn(o.values, addr(A, "sku"))).toBe(false);
  });

  it("source changed → needs_update; the old translation stays visible", () => {
    const s = snapshot([entry(A, { label: "Prices", link: { href: "/pricing" } })]);
    const idx = index({ [addr(A, "label")]: { value: "Preise", hash: textHash("Pricing") } });
    const u = s.units.find((x) => x.address === addr(A, "label"));
    expect(u && unitStatus(u, "de", idx)).toBe("needs_update");
    expect(overlay(s, idx).values[addr(A, "label")]).toBe("Preise");
  });

  it("moved → nothing: the address of a value does not depend on its position", () => {
    const before = snapshot([entry(A, { label: "A" }), entry(B, { label: "B" })]);
    const after = snapshot([entry(B, { label: "B" }, [entry(A, { label: "A" })])]);
    expect(new Set(after.units.map((u) => u.address))).toEqual(
      new Set(before.units.map((u) => u.address)),
    );
  });

  const row = (address: string, over: Partial<ReconcileRow> = {}): ReconcileRow => ({
    id: `r-${address}`,
    locale: "de",
    address,
    hasValue: true,
    hash: textHash("Pricing"),
    status: "translated",
    orphanedAt: null,
    ...over,
  });

  it("removed entry / deleted list / dropped field → orphaned, not deleted", () => {
    const s = snapshot([]); // the entry (or the whole list, or the field) is gone
    const plan = reconcile(s, ["de"], [row(addr(A, "label"))], "2026-10-25T10:00:00.000Z");
    expect(plan.updates).toEqual([
      { id: `r-${addr(A, "label")}`, status: "orphaned", orphanedAt: "2026-10-25T10:00:00.000Z" },
    ]);
  });

  it("an undo of the removal restores the orphaned translation", () => {
    const s = snapshot(items);
    const plan = reconcile(
      s,
      ["de"],
      [row(addr(A, "label"), { status: "orphaned", orphanedAt: "2026-10-25T10:00:00.000Z" })],
      "2026-10-25T11:00:00.000Z",
    );
    expect(plan.updates).toEqual([
      { id: `r-${addr(A, "label")}`, status: "translated", orphanedAt: null },
    ]);
  });

  it("translate switched on → missing (a row is created); off → kept, not applied, not orphaned", () => {
    const on = reconcile(snapshot(items), ["de"], [], "t");
    expect(on.inserts.map((i) => i.unit.address)).toContain(addr(A, "label"));
    expect(on.inserts.map((i) => i.unit.address)).not.toContain(addr(A, "sku"));
    // The sku has a stored translation from when it was translatable.
    const off = reconcile(snapshot(items), ["de"], [row(addr(A, "sku"))], "t");
    expect(off.updates).toEqual([]);
    expect(Object.hasOwn(overlay(snapshot(items), index({})).values, addr(A, "sku"))).toBe(false);
  });

  it("a link target without a version in the language hides the entry and is a finding", () => {
    const s = snapshot(items);
    const idx = index({ [addr(A, "label")]: { value: "Preise", hash: textHash("Pricing") } });
    const noDe = (href: string) => href !== "/pricing";
    expect(overlay(s, idx, noDe).hidden.filter((h) => h.startsWith(`list/${LIST}/`))).toEqual([
      entryAddr(A),
    ]);
    const findings = findingsFor(s, { code: "de", display_name: "Deutsch" }, idx, noDe, none);
    expect(findings.map((f) => f.code)).toContain("list-link-variant-missing");
    expect(findings.find((f) => f.code === "list-link-variant-missing")?.message).toContain(
      "link target has no Deutsch (de) version",
    );
  });

  it("an entry the operator hid in a language is hidden there and not asked for", () => {
    const s = snapshot(items);
    const o = overlayFor(s, "de", index({}), allLinksOk, new Set([entryAddr(A)]));
    expect(o.hidden).toContain(entryAddr(A));
    const findings = findingsFor(
      s,
      { code: "de", display_name: "Deutsch" },
      index({}),
      allLinksOk,
      new Set([entryAddr(A)]),
    );
    expect(findings.filter((f) => f.target === `list:${LIST}`)).toEqual([]);
  });

  it("a query node stores nothing: only its own fields are units", () => {
    const q: ListTypeDef = {
      slug: "news",
      name: "News",
      purpose: "Latest",
      role: "content",
      root: { allow: ["latest"] },
      nodes: {
        latest: {
          label: "Latest",
          fields: [{ name: "heading", label: "Heading", type: "text" }],
          source: {
            kind: "query",
            editable: ["limit"],
            defaults: { order: "published_desc", limit: 3 },
          },
        },
      },
    };
    const s = collectSources({
      listTypes: new Map([["news", q]]),
      lists: [
        {
          id: LIST,
          slug: "news",
          name: "News",
          type: "news",
          items: [
            { id: A, node: "latest", values: { heading: "Latest news" }, query: { limit: 5 } },
          ],
        },
      ],
      instances: [],
      pageProps: [],
    });
    expect(s.units.map((u) => u.address)).toEqual([addr(A, "heading")]);
  });
});

describe("terms, local lists and page properties", () => {
  it("a vocabulary entry's name and slug are one term with one change detector", () => {
    const s = snapshot([]);
    const parts = s.units.filter((u) => u.store === "term");
    expect(parts.map((u) => u.term?.part).sort()).toEqual(["name", "slug"]);
    expect(new Set(parts.map((u) => u.hash)).size).toBe(1);
  });

  it("local list entries are addressed by instance and apply only to the instance's languages", () => {
    const s = snapshot([], { instance: [entry(C, { label: "Imprint" })] });
    const u = s.units.find((x) => x.address === `instance/${CI}/links/item/${C}/label`);
    expect(u?.locales).toEqual(new Set(["de"]));
    expect(overlayFor(s, "fr", index({}), allLinksOk, none).hidden).not.toContain(
      `instance/${CI}/links/item/${C}`,
    );
    expect(overlay(s, index({})).hidden).toContain(`instance/${CI}/links/item/${C}`);
  });

  it("a page property is translated from the source page and never hides the page", () => {
    const s = snapshot([], { props: "Fair plans" });
    const u = s.units.find((x) => x.address === `page/${PAGE}/props/subtitle`);
    expect(u?.text).toBe("Fair plans");
    const o = overlay(s, index({}));
    expect(Object.hasOwn(o.values, `page/${PAGE}/props/subtitle`)).toBe(false);
    const done = overlay(
      s,
      index({
        [`page/${PAGE}/props/subtitle`]: { value: "Faire Preise", hash: textHash("Fair plans") },
      }),
    );
    expect(done.values[`page/${PAGE}/props/subtitle`]).toBe("Faire Preise");
  });
});
