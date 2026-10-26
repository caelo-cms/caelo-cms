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
import type { ListTypeDef, PluginAdminQuery } from "@caelo-cms/plugin-sdk";
import type { LocaleRow } from "./index.js";
import {
  outcomeNextStep,
  type PreparedPageTranslation,
  pageSlotsOf,
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

function placements(opts: { nestedExclusive: boolean; nestedTitle: string }) {
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
          exclusive: opts.nestedExclusive,
        },
      ],
    },
  ];
}

describe("page translation slots", () => {
  it("offers default texts, local list entries and nested content to the translator", () => {
    const { slots } = pageSlotsOf(
      placements({ nestedExclusive: true, nestedTitle: "Karte" }),
      LIST_TYPES,
    );
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
    const { bases } = pageSlotsOf(
      placements({ nestedExclusive: true, nestedTitle: "Karte" }),
      LIST_TYPES,
    );
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

  function prepared(nestedExclusive: boolean): PreparedPageTranslation {
    const source = pageSlotsOf(
      placements({ nestedExclusive: true, nestedTitle: "Karte" }),
      LIST_TYPES,
    );
    const variant = pageSlotsOf(placements({ nestedExclusive, nestedTitle: "Karte" }), LIST_TYPES);
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

  function deps() {
    const calls: [string, unknown][] = [];
    const statuses: unknown[] = [];
    return {
      calls,
      statuses,
      deps: {
        q: {
          update: async (_t: string, _id: string, data: unknown) => {
            statuses.push(data);
          },
        } as unknown as PluginAdminQuery,
        cms: {
          call: async <O>(op: string, input: unknown): Promise<O> => {
            calls.push([op, input]);
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

  const ids = (p: PreparedPageTranslation) => [...buildSlotIndex(p.sourceSlots).keys()];

  it("writes nested content to the variant's own instance", async () => {
    const p = prepared(true);
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
      [
        "page_module_content.set",
        {
          pageId: "page-en",
          blockName: "main",
          position: 0,
          contentValues: { heading: "Jetzt testen", submit_label: "Request a demo" },
        },
      ],
      ["content_instances.set_values", { id: "ci-card-1", values: { card_title: "Card" } }],
    ]);
    expect(d.statuses).toEqual([{ translation_status: "up_to_date" }]);
  });

  it("leaves nested content another page shares untouched, and says what to do", async () => {
    const p = prepared(false);
    const [, , , card] = ids(p);
    const d = deps();
    const out = await writePageTranslation(d.deps, p, {
      slots: [{ slot: card as string, values: { card_title: "Card" } }],
    });
    expect(d.calls).toEqual([]);
    expect(out.sharedNested).toEqual(["main #2 > cards[0]"]);
    // Not up to date: part of the page is still in the source language.
    expect(d.statuses).toEqual([]);
    expect(outcomeNextStep(out)).toContain("fork_placement_content");
  });
});
