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
    expect(index.declaration("stand")?.type).toBe("date");
    expect(index.declaration("fuer_wen")?.type).toBe("text");
    expect(index.declaration("stnad")).toBeUndefined();
  });

  it("takes the first page type by slug when several declare a name, whatever the load order", () => {
    const product = pageType("product", [{ name: "cta", label: "CTA", type: "text" }]);
    const news = pageType("news", [{ name: "cta", label: "CTA", type: "link" }]);
    for (const order of [
      [product, news],
      [news, product],
    ]) {
      expect(pagePropertyIndex(new Map(order)).declaration("cta")?.type).toBe("link");
    }
  });

  it("names the property in its failure marker", () => {
    expect(pagePropUnknownMarker("stnad")).toBe("page-prop-unknown:stnad");
  });
});
