// SPDX-License-Identifier: MPL-2.0

/**
 * #1659 — rows that came to share a key read as one, by one rule, in
 * every reader: a translation and the change consumer's `missing`
 * placeholder for the same page property used to read as whichever id
 * sorted last, so the page rendered the source text and intl_status said
 * missing although the translation was stored.
 */

import { describe, expect, it } from "bun:test";
import { translationIndexOf } from "./list-translation-ops.js";
import {
  onePerChromeTarget,
  onePerHiddenEntry,
  onePerPageProp,
  onePerTerm,
  onePerValueAddress,
} from "./translation-rows.js";

const PAGE = "00000000-0000-4000-8000-0000000016a1";
const LIST = "00000000-0000-4000-8000-0000000016b1";
const ITEM = "00000000-0000-4000-8000-0000000016c1";

function prop(id: string, over: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    locale_code: "en",
    page_id: PAGE,
    field: "grafik_svg",
    value: null as string | null,
    source_hash: null as string | null,
    status: "missing" as "translated" | "needs_update" | "missing" | "orphaned",
    orphaned_at: null,
    created_at: "2026-11-19T10:00:00.000Z",
    ...over,
  };
}

describe("#1659 — one stored translation per key", () => {
  it("a translation beats the placeholder beside it, whichever id sorts last", () => {
    const translated = prop("00000000-0000-4000-8000-000000000001", {
      value: "Three more domains",
      source_hash: "h1",
      status: "translated",
    });
    const placeholder = prop("ffffffff-ffff-4fff-8fff-ffffffffffff");
    for (const rows of [
      [translated, placeholder],
      [placeholder, translated],
    ]) {
      const { index } = translationIndexOf({ values: [], terms: [], props: rows, visibility: [] });
      expect(index.get(`en|page/${PAGE}/props/grafik_svg`)).toEqual({
        value: "Three more domains",
        hash: "h1",
      });
      const one = onePerPageProp(rows);
      expect(one.rows).toEqual([translated]);
      expect(one.folded).toEqual([placeholder]);
    }
  });

  it("then a current translation beats an outdated one, then the later insert, then the id", () => {
    const outdated = prop("a", { value: "old", status: "needs_update" });
    const current = prop("b", { value: "new", status: "translated" });
    expect(onePerPageProp([outdated, current]).rows).toEqual([current]);

    const earlier = prop("c", { value: "one", status: "translated" });
    const later = prop("d", {
      value: "two",
      status: "translated",
      created_at: "2026-11-19T10:00:01.000Z",
    });
    expect(onePerPageProp([later, earlier]).rows).toEqual([later]);

    const x = prop("x", { value: "same", status: "translated" });
    const y = prop("y", { value: "same", status: "translated" });
    expect(onePerPageProp([y, x]).rows).toEqual([x]);
  });

  it("keeps rows of different keys apart, in the order their keys first appear", () => {
    const a = prop("1", { field: "teaser" });
    const b = prop("2", { field: "stand" });
    const c = prop("3", { locale_code: "de", field: "teaser" });
    expect(onePerPageProp([a, b, c])).toEqual({ rows: [a, b, c], folded: [] });
  });

  it("applies the same rule to list values, terms, hidden entries and chrome", () => {
    const value = (id: string, v: string | null) => ({
      id,
      locale_code: "de",
      address: `list/${LIST}/item/${ITEM}/label`,
      value: v,
      status: v === null ? "missing" : "translated",
    });
    expect(onePerValueAddress([value("2", null), value("1", "Preise")]).rows).toEqual([
      value("1", "Preise"),
    ]);

    const term = (id: string, name: string | null) => ({
      id,
      locale_code: "de",
      list_id: LIST,
      item_id: ITEM,
      name,
      slug: name === null ? null : "nachrichten",
      status: name === null ? "missing" : "translated",
    });
    expect(onePerTerm([term("2", null), term("1", "Nachrichten")]).rows).toEqual([
      term("1", "Nachrichten"),
    ]);

    const hidden = (id: string, h: boolean) => ({
      id,
      locale_code: "de",
      address: `list/${LIST}/item/${ITEM}`,
      hidden: h,
    });
    expect(onePerHiddenEntry([hidden("1", false), hidden("2", true)]).rows).toEqual([
      hidden("2", true),
    ]);

    const chrome = (id: string, status: string) => ({
      id,
      target_key: "layout:x:footer:0",
      locale_code: "de",
      translation_status: status,
    });
    expect(
      onePerChromeTarget([chrome("1", "needs_update"), chrome("2", "up_to_date")]).rows,
    ).toEqual([chrome("2", "up_to_date")]);
  });
});
