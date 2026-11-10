// SPDX-License-Identifier: MPL-2.0

/**
 * Page translation reaches every text the page shows, not only the
 * stored values: copy that renders from a field DEFAULT (the module
 * extractor turns literal button labels, form labels and menu entries
 * into defaults), the entries of a page's own local lists, and nested
 * module content. Regression for "fixed German texts in modules (menu,
 * demo form, buttons) never get translated".
 */

import { describe, expect, it } from "bun:test";
import { indexCheckedQuery, type ListTypeDef, type PluginAdminQuery } from "@caelo-cms/plugin-sdk";
import plugin, { type LocaleRow } from "./index.js";
import {
  type PreparedPageTranslation,
  pageSlotsOf,
  pageSourceFingerprint,
  translatedValues,
  writePageTranslation,
} from "./page-translation.js";
import { alignSlots, buildSlotIndex } from "./translation.js";

const ENTRY = "00000000-0000-4000-9000-000000000001";
const ENTRY2 = "00000000-0000-4000-9000-000000000002";

const LIST_TYPES = new Map<string, ListTypeDef>([
  [
    "links",
    {
      slug: "links",
      label: "Links",
      nodes: {
        link: {
          label: "Link",
          fields: [
            { name: "label", label: "Label", type: "text", required: true },
            { name: "link", label: "Link", type: "link", required: true },
          ],
        },
      },
      roots: ["link"],
    } as unknown as ListTypeDef,
  ],
]);

const FORM_FIELDS = [
  { name: "heading", kind: "text" },
  { name: "submit_label", kind: "text", default: "Demo anfragen" },
  { name: "email_placeholder", kind: "text", default: "Ihre E-Mail" },
  { name: "action", kind: "url", default: "/api/forms/demo" },
];

const MENU_FIELDS = [
  {
    name: "items",
    kind: "list",
    listType: "links",
    bind: "local" as const,
    default: [
      { id: ENTRY, node: "link", values: { label: "Preise", link: { href: "/preise" } } },
      { id: ENTRY2, node: "link", values: { label: "Kontakt", link: { href: "/kontakt" } } },
    ],
  },
];

const CARD_FIELDS = [{ name: "card_title", kind: "text" }];

function placements(opts: { nestedTitle: string }) {
  return [
    {
      blockName: "main",
      position: 0,
      moduleSlug: "demo-form",
      contentInstanceId: "ci-form",
      // Only the heading is stored; the button and placeholder render
      // from the module's defaults.
      values: { heading: "Jetzt testen" },
      fields: FORM_FIELDS,
      nested: [],
    },
    {
      blockName: "main",
      position: 1,
      moduleSlug: "menu",
      contentInstanceId: "ci-menu",
      values: {},
      fields: MENU_FIELDS,
      nested: [],
    },
    {
      blockName: "main",
      position: 2,
      moduleSlug: "cards",
      contentInstanceId: "ci-cards",
      values: { cards: [{ moduleId: "m-card", contentInstanceId: "ci-card-1" }] },
      fields: [{ name: "cards", kind: "module-list" }],
      nested: [
        {
          path: "cards[0]",
          contentInstanceId: "ci-card-1",
          moduleSlug: "card",
          fields: CARD_FIELDS,
          values: { card_title: opts.nestedTitle },
        },
      ],
    },
  ];
}

describe("page translation slots", () => {
  it("offers default texts, local list entries and nested content to the translator", () => {
    const { slots } = pageSlotsOf(placements({ nestedTitle: "Karte" }), LIST_TYPES);
    expect(slots).toEqual([
      {
        blockName: "main",
        position: 0,
        moduleSlug: "demo-form",
        values: {
          heading: "Jetzt testen",
          submit_label: "Demo anfragen",
          email_placeholder: "Ihre E-Mail",
        },
      },
      {
        blockName: "main",
        position: 1,
        moduleSlug: "menu",
        values: { [`items[${ENTRY}].label`]: "Preise", [`items[${ENTRY2}].label`]: "Kontakt" },
      },
      { blockName: "main", position: 2, moduleSlug: "cards", values: {} },
      {
        blockName: "main",
        position: 2,
        nestedPath: "cards[0]",
        moduleSlug: "card",
        values: { card_title: "Karte" },
      },
    ]);
  });

  it("writes defaults and list entries into the variant's own values, not the module", () => {
    const { bases } = pageSlotsOf(placements({ nestedTitle: "Karte" }), LIST_TYPES);
    const form = bases.get("main|0");
    const menu = bases.get("main|1");
    if (!form || !menu) throw new Error("missing bases");
    expect(translatedValues(form, form, { submit_label: "Request a demo" })).toEqual({
      heading: "Jetzt testen",
      submit_label: "Request a demo",
    });
    expect(translatedValues(menu, menu, { [`items[${ENTRY}].label`]: "Pricing" })).toEqual({
      items: [
        { id: ENTRY, node: "link", values: { label: "Pricing", link: { href: "/preise" } } },
        { id: ENTRY2, node: "link", values: { label: "Kontakt", link: { href: "/kontakt" } } },
      ],
    });
  });

  it("a list keeps the source's entries and the variant's existing text", () => {
    const source = {
      values: {
        items: [
          { id: ENTRY, node: "link", values: { label: "Preise", link: { href: "/preise" } } },
          { id: ENTRY2, node: "link", values: { label: "Neu", link: { href: "/neu" } } },
        ],
      },
      fields: MENU_FIELDS,
    };
    const variant = {
      values: {
        items: [
          { id: ENTRY, node: "link", values: { label: "Pricing", link: { href: "/preise" } } },
        ],
      },
      fields: MENU_FIELDS,
    };
    expect(translatedValues(variant, source, { [`items[${ENTRY2}].label`]: "New" })).toEqual({
      items: [
        { id: ENTRY, node: "link", values: { label: "Pricing", link: { href: "/preise" } } },
        { id: ENTRY2, node: "link", values: { label: "New", link: { href: "/neu" } } },
      ],
    });
  });
});

describe("writePageTranslation", () => {
  const de: LocaleRow = {
    id: "l-de",
    code: "de",
    display_name: "Deutsch",
    url_strategy: "none",
    url_host: null,
    is_default: true,
  };
  const en: LocaleRow = {
    ...de,
    id: "l-en",
    code: "en",
    display_name: "English",
    is_default: false,
  };

  function prepared(): PreparedPageTranslation {
    const source = pageSlotsOf(placements({ nestedTitle: "Karte" }), LIST_TYPES);
    const variant = pageSlotsOf(placements({ nestedTitle: "Karte" }), LIST_TYPES);
    return {
      variantPageId: "page-en",
      variantRowId: "v-en",
      sourceLocale: de,
      targetLocale: en,
      mode: "full",
      prompt: { system: "", user: "" },
      sourceTitle: "Demo",
      variantTitle: "Demo",
      sourceMetaDescription: "",
      variantMetaDescription: "",
      sourceSlots: source.slots,
      variantSlots: variant.slots,
      sourceBases: source.bases,
      variantBases: variant.bases,
      alignment: alignSlots(source.slots, variant.slots),
      glossary: [],
      styleGuide: null,
    };
  }

  /**
   * A recording `cms`. `relisted` is what `list_for_page` returns after a
   * fork (the variant's placements, bound to the copies). `renderedOn`
   * says where an instance renders besides the variant page; `languages`
   * holds the pages that are in a variant group.
   */
  function deps(
    opts: {
      relisted?: ReturnType<typeof placements>;
      renderedOn?: Record<string, string[]>;
      languages?: Record<string, string>;
      siteWide?: string[];
    } = {},
  ) {
    const calls: [string, unknown][] = [];
    const statuses: unknown[] = [];
    return {
      calls,
      statuses,
      deps: {
        q: indexCheckedQuery(plugin, "adminSchema", {
          list: async (_t: string, filter: { anyOf: { page_id: string[] } }) =>
            filter.anyOf.page_id.flatMap((page_id) => {
              const locale_code = opts.languages?.[page_id];
              return locale_code ? [{ page_id, locale_code }] : [];
            }),
          update: async (_t: string, _id: string, data: unknown) => {
            statuses.push(data);
          },
        }) as unknown as PluginAdminQuery,
        cms: {
          call: async <O>(op: string, input: unknown): Promise<O> => {
            calls.push([op, input]);
            if (op === "content_instances.rendered_on_many") {
              return {
                instances: (input as { ids: string[] }).ids.map((id) => ({
                  id,
                  pageIds: ["page-en", ...(opts.renderedOn?.[id] ?? [])],
                  siteWide: opts.siteWide?.includes(id) ?? false,
                })),
              } as O;
            }
            if (op === "page_module_content.list_for_page") {
              return { placements: opts.relisted ?? [] } as O;
            }
            if (op === "list_types.list") {
              return {
                listTypes: [...LIST_TYPES].map(([slug, definition]) => ({ slug, definition })),
              } as O;
            }
            return {} as O;
          },
        },
        locales: new Map([
          ["de", de],
          ["en", en],
        ]),
      },
    };
  }

  /** The recorded calls that change something. */
  const writes = (d: { calls: [string, unknown][] }) =>
    d.calls.filter(([op]) => op === "page_module_content.set" || op === "placement.fork_paths");

  const ids = (p: PreparedPageTranslation) => [...buildSlotIndex(p.sourceSlots).keys()];

  it("writes nested content through the variant page's placement", async () => {
    const p = prepared();
    const [form, , , card] = ids(p);
    const d = deps();
    const out = await writePageTranslation(d.deps, p, {
      slots: [
        { slot: form as string, values: { submit_label: "Request a demo" } },
        { slot: card as string, values: { card_title: "Card" } },
      ],
    });
    expect(out).toEqual({
      mode: "full",
      slotsApplied: 2,
      titleApplied: false,
      seo: "untranslated",
    });
    expect(d.calls).toEqual([
      ["content_instances.rendered_on_many", { ids: ["ci-form", "ci-cards", "ci-card-1"] }],
      [
        "page_module_content.set",
        {
          pageId: "page-en",
          blockName: "main",
          position: 0,
          contentValues: { heading: "Jetzt testen", submit_label: "Request a demo" },
          alsoChangesPages: [],
        },
      ],
      [
        "page_module_content.set",
        {
          pageId: "page-en",
          blockName: "main",
          position: 2,
          nestedPath: "cards[0]",
          contentValues: { card_title: "Card" },
          alsoChangesPages: [],
        },
      ],
    ]);
    // #1267 — with the fingerprint of the source the translation was made from.
    expect(d.statuses).toEqual([
      {
        translation_status: "up_to_date",
        source_hash: await pageSourceFingerprint({
          title: p.sourceTitle,
          shortTitle: p.sourceShortTitle,
          metaDescription: p.sourceMetaDescription,
          slots: p.sourceSlots,
        }),
      },
    ]);
  });

  const at = { pageId: "page-en", blockName: "main", position: 2 };

  it("#1453 — writes content other pages of the language share in place, naming them", async () => {
    const p = prepared();
    const [, , , card] = ids(p);
    const d = deps({
      renderedOn: { "ci-card-1": ["page-en-2"] },
      languages: { "page-en-2": "en" },
    });
    const out = await writePageTranslation(d.deps, p, {
      slots: [{ slot: card as string, values: { card_title: "Card" } }],
    });
    expect(writes(d)).toEqual([
      [
        "page_module_content.set",
        {
          ...at,
          nestedPath: "cards[0]",
          contentValues: { card_title: "Card" },
          alsoChangesPages: ["page-en-2"],
        },
      ],
    ]);
    expect(out.slotsApplied).toBe(1);
    expect(d.statuses).toHaveLength(1);
  });

  it("#1453 — copies only the instance the source language shares, then writes the copy", async () => {
    const p = prepared();
    const [, , , card] = ids(p);
    const d = deps({
      relisted: placements({ nestedTitle: "Karte" }),
      // A page in no group is a page of the default language.
      renderedOn: { "ci-card-1": ["page-de"] },
    });
    await writePageTranslation(d.deps, p, {
      slots: [{ slot: card as string, values: { card_title: "Card" } }],
    });
    expect(writes(d)).toEqual([
      [
        "placement.fork_paths",
        { ...at, root: false, nestedPaths: ["cards[0]"], alsoChangesPages: [] },
      ],
      [
        "page_module_content.set",
        {
          ...at,
          nestedPath: "cards[0]",
          contentValues: { card_title: "Card" },
          alsoChangesPages: [],
        },
      ],
    ]);
    // The bases are read back between the copy and the write.
    expect(d.calls.map(([op]) => op).indexOf("page_module_content.list_for_page")).toBeGreaterThan(
      d.calls.map(([op]) => op).indexOf("placement.fork_paths"),
    );
  });

  it("#1453 — a shared chain is copied from the placement down", async () => {
    const p = prepared();
    const [, , , card] = ids(p);
    const d = deps({
      relisted: placements({ nestedTitle: "Karte" }),
      renderedOn: { "ci-cards": ["page-de"], "ci-card-1": ["page-de"] },
      languages: { "page-de": "de" },
    });
    await writePageTranslation(d.deps, p, {
      slots: [{ slot: card as string, values: { card_title: "Card" } }],
    });
    expect(writes(d)[0]).toEqual([
      "placement.fork_paths",
      { ...at, root: true, nestedPaths: ["cards[0]"], alsoChangesPages: [] },
    ]);
  });

  it("#1453 — content in chrome or a shared list counts as every language's", async () => {
    const p = prepared();
    const [, , , card] = ids(p);
    const d = deps({ relisted: placements({ nestedTitle: "Karte" }), siteWide: ["ci-card-1"] });
    await writePageTranslation(d.deps, p, {
      slots: [{ slot: card as string, values: { card_title: "Card" } }],
    });
    expect(writes(d)[0]?.[0]).toBe("placement.fork_paths");
  });

  it("#1453 — asks where content renders in batches the op takes", async () => {
    const big = placements({ nestedTitle: "Karte" }).map((pl) =>
      pl.position !== 2
        ? pl
        : {
            ...pl,
            nested: Array.from({ length: 1001 }, (_, i) => ({
              path: `cards[${i}]`,
              contentInstanceId: `ci-card-${i}`,
              moduleSlug: "card",
              fields: CARD_FIELDS,
              values: { card_title: `Karte ${i}` },
            })),
          },
    );
    const slots = pageSlotsOf(big, LIST_TYPES);
    const p: PreparedPageTranslation = {
      ...prepared(),
      sourceSlots: slots.slots,
      variantSlots: slots.slots,
      sourceBases: slots.bases,
      variantBases: slots.bases,
      alignment: alignSlots(slots.slots, slots.slots),
    };
    const d = deps();
    await writePageTranslation(d.deps, p, {
      slots: ids(p)
        .slice(3)
        .map((slot) => ({ slot, values: { card_title: "Card" } })),
    });
    const reads = d.calls.filter(([op]) => op === "content_instances.rendered_on_many");
    expect(reads.map(([, input]) => (input as { ids: string[] }).ids.length)).toEqual([1000, 2]);
  });

  it("#1453 — an answer that repeats the current text writes and asks nothing", async () => {
    const p = prepared();
    const [form, , , card] = ids(p);
    const d = deps();
    const out = await writePageTranslation(d.deps, p, {
      slots: [
        { slot: form as string, values: { submit_label: "Demo anfragen" } },
        { slot: card as string, values: { card_title: "Karte" } },
      ],
    });
    expect(d.calls).toEqual([]);
    expect(out.slotsApplied).toBe(0);
    // Still up to date: the translator confirmed the text.
    expect(d.statuses).toHaveLength(1);
  });

  it("#1309 — writes each slot into its own section when the variant's sections are reordered", async () => {
    const source = pageSlotsOf(placements({ nestedTitle: "Karte" }), LIST_TYPES);
    // The variant has the cards first and the form last.
    const reordered = placements({ nestedTitle: "Karte" });
    const [form, menu, cards] = reordered;
    if (!form || !menu || !cards) throw new Error("fixture");
    const variantPlacements = [
      { ...cards, position: 0 },
      { ...menu, position: 1 },
      { ...form, position: 2 },
    ];
    const variant = pageSlotsOf(variantPlacements, LIST_TYPES);
    const p: PreparedPageTranslation = {
      ...prepared(),
      variantSlots: variant.slots,
      variantBases: variant.bases,
      alignment: alignSlots(source.slots, variant.slots),
    };
    expect(p.alignment.every((a) => a.kind === "aligned")).toBe(true);
    const [formSlot, , , card] = ids(p);
    const d = deps();
    await writePageTranslation(d.deps, p, {
      slots: [
        { slot: formSlot as string, values: { submit_label: "Request a demo" } },
        { slot: card as string, values: { card_title: "Card" } },
      ],
    });
    expect(writes(d)).toEqual([
      [
        "page_module_content.set",
        {
          pageId: "page-en",
          blockName: "main",
          position: 2,
          contentValues: { heading: "Jetzt testen", submit_label: "Request a demo" },
          alsoChangesPages: [],
        },
      ],
      [
        "page_module_content.set",
        {
          pageId: "page-en",
          blockName: "main",
          position: 0,
          nestedPath: "cards[0]",
          contentValues: { card_title: "Card" },
          alsoChangesPages: [],
        },
      ],
    ]);
  });
});
