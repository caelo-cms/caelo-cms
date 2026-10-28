// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { pluginEditorToolbarState } from "@caelo-cms/plugin-sdk";
import { languageToolbarState } from "./editor-toolbar.js";
import type { LocaleRow, PageVariantRow } from "./index.js";

const EN = "00000000-0000-4000-8000-000000000001";
const DE = "00000000-0000-4000-8000-000000000002";
const LONE = "00000000-0000-4000-8000-000000000003";

function locale(code: string, name: string, isDefault = false): LocaleRow {
  return {
    id: `loc-${code}`,
    code,
    display_name: name,
    url_strategy: "subdirectory",
    url_host: null,
    is_default: isDefault,
  };
}

function variant(
  pageId: string,
  code: string,
  status: PageVariantRow["translation_status"],
): PageVariantRow {
  return {
    id: `v-${pageId}`,
    group_id: "g1",
    page_id: pageId,
    locale_code: code,
    translation_status: status,
    source_event_cursor: null,
  };
}

const locales = [locale("en", "English", true), locale("de", "Deutsch"), locale("fr", "Français")];
const pages = new Map([
  [EN, { id: EN, status: "published" }],
  [DE, { id: DE, status: "draft" }],
  [LONE, { id: LONE, status: "published" }],
]);

describe("languageToolbarState", () => {
  it("shows the source page's language and every other version", () => {
    const state = languageToolbarState({
      pageId: EN,
      locales,
      variants: [variant(EN, "en", "source"), variant(DE, "de", "needs_update")],
      pages,
    });
    expect(pluginEditorToolbarState.parse(state)).toEqual(state);
    expect(state).toEqual({
      label: "EN",
      count: 1,
      tone: "attention",
      summary: "This page is in English. 1 of 2 other languages have a version, 1 out of date.",
      items: [
        { label: "English", detail: "This page · Source", current: true },
        { label: "Deutsch", detail: "Out of date · draft", tone: "attention", pageId: DE },
        { label: "Français", detail: "Not translated" },
      ],
    });
  });

  it("names the shown page's own staleness", () => {
    const state = languageToolbarState({
      pageId: DE,
      locales,
      variants: [variant(EN, "en", "source"), variant(DE, "de", "needs_update")],
      pages,
    });
    expect(state.label).toBe("DE");
    expect(state.count).toBe(1);
    expect(state.summary).toBe(
      "This page is in Deutsch and out of date with its source. 1 of 2 other languages have a version.",
    );
    expect(state.items?.[0]).toEqual({
      label: "Deutsch",
      detail: "This page · Out of date · draft",
      tone: "attention",
      current: true,
    });
  });

  it("puts a page without a variant row in the default language, nothing to count", () => {
    const state = languageToolbarState({ pageId: LONE, locales, variants: [], pages });
    expect(state.label).toBe("EN");
    expect(state.count).toBeUndefined();
    expect(state.tone).toBeUndefined();
    expect(state.items?.map((i) => i.detail)).toEqual([
      "This page · Source",
      "Not translated",
      "Not translated",
    ]);
  });

  it("stays within the toolbar state's 20 entries on a site with more languages", () => {
    const many = [
      locale("en", "English", true),
      ...Array.from({ length: 24 }, (_, i) => locale(`l${i}`, `Language ${i}`)),
    ];
    const stale = variant(DE, "l23", "needs_update");
    const state = languageToolbarState({
      pageId: EN,
      locales: many,
      variants: [variant(EN, "en", "source"), stale],
      pages,
    });
    expect(pluginEditorToolbarState.safeParse(state).success).toBe(true);
    expect(state.items).toHaveLength(20);
    // The shown page and the out-of-date version are kept; the rest fold.
    expect(state.items?.[0]?.current).toBe(true);
    expect(state.items?.[1]).toMatchObject({ label: "Language 23", tone: "attention" });
    expect(state.items?.[19]).toEqual({
      label: "6 more languages",
      detail: "Ask the AI for the full status",
    });
    expect(state.count).toBe(1);
  });

  it("shortens a language name longer than an entry label may be", () => {
    const long = "L".repeat(120);
    const state = languageToolbarState({
      pageId: EN,
      locales: [locale("en", "English", true), locale("de", long)],
      variants: [],
      pages,
    });
    expect(pluginEditorToolbarState.safeParse(state).success).toBe(true);
    expect(state.items?.[1]?.label).toBe(`${"L".repeat(79)}…`);
  });

  it("asks for languages when none are set up", () => {
    const state = languageToolbarState({ pageId: EN, locales: [], variants: [], pages });
    expect(state).toEqual({
      tone: "attention",
      summary: "No languages are set up yet. Ask the AI to add the site's languages.",
    });
  });

  it("fails loudly on a variant row in a language that is not set up", () => {
    expect(() =>
      languageToolbarState({
        pageId: DE,
        locales,
        variants: [{ ...variant(DE, "it", "up_to_date") }],
        pages,
      }),
    ).toThrow('is marked as "it", which is not a set-up language');
  });
});
