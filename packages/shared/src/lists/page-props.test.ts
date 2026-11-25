// SPDX-License-Identifier: MPL-2.0

/** #1561 — the page-property index behind `{{page.props.<name>}}` (`page-props.ts`). */

import { describe, expect, it } from "bun:test";
import type { FieldDef } from "./fields.js";
import { pagePropertyIndex, pagePropUnknownMarker } from "./page-props.js";
import type { LoadedPageType } from "./render-data.js";

const TEMPLATE = "00000000-0000-4000-8000-000000000801";

function pageType(slug: string, properties: FieldDef[]): [string, LoadedPageType] {
  return [
    slug,
    {
      id: `type-${slug}`,
      def: {
        slug,
        name: slug,
        purpose: `${slug} pages.`,
        collection: false,
        templates: [TEMPLATE],
        defaultTemplate: TEMPLATE,
        properties,
        vocabularies: [],
      },
    },
  ];
}

describe("pagePropertyIndex", () => {
  it("knows every property any page type declares, and nothing else", () => {
    const index = pagePropertyIndex(
      new Map([
        pageType("hilfe", [
          { name: "stand", label: "Stand", type: "date" },
          { name: "fuer_wen", label: "Für wen", type: "text" },
        ]),
        pageType("home", []),
      ]),
    );
    expect(index.absent("stand")).toMatchObject({ kind: "record", present: false });
    expect(index.absent("fuer_wen")).toEqual({ kind: "text", text: "" });
    expect(index.absent("stnad")).toBeUndefined();
  });

  it("reads a select property's option flags as false, and no other name", () => {
    const index = pagePropertyIndex(
      new Map([
        pageType("product", [
          { name: "layout", label: "Layout", type: "select", options: ["wide", "narrow"] },
        ]),
      ]),
    );
    expect(index.absent("layout_wide")).toEqual({ kind: "bool", value: false });
    expect(index.absent("layout_narrow")).toEqual({ kind: "bool", value: false });
    expect(index.absent("layout_huge")).toBeUndefined();
  });

  it("answers the paths of each declaration when page types declare a name differently, whatever the load order", () => {
    const product = pageType("product", [{ name: "cta", label: "CTA", type: "text" }]);
    const news = pageType("news", [{ name: "cta", label: "CTA", type: "link" }]);
    const event = pageType("event", [{ name: "cta", label: "CTA", type: "date" }]);
    for (const order of [
      [product, news, event],
      [event, news, product],
    ]) {
      const cta = pagePropertyIndex(new Map(order)).absent("cta");
      if (cta?.kind !== "record") throw new Error(`expected a record, got ${cta?.kind}`);
      expect(cta.text).toBe("");
      expect(cta.present).toBe(false);
      expect(cta.get("href")).toEqual({ kind: "text", text: "" });
      expect(cta.get("formatted")).toEqual({ kind: "text", text: "" });
      expect(cta.get("nope")).toBeUndefined();
    }
  });

  it("names the property in its failure marker", () => {
    expect(pagePropUnknownMarker("stnad")).toBe("page-prop-unknown:stnad");
  });
});
