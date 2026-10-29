// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { publishChangedPages } from "./publish-changed-pages.js";

describe("publishChangedPages", () => {
  it("unions the impact pages with the chat's page edits", () => {
    expect(
      publishChangedPages({
        impact: { pageIds: ["a"], fullSite: false },
        pagesChecked: true,
        editedPageIds: ["b"],
        editedPageLayoutPageIds: ["a", "c"],
      }),
    ).toEqual(["a", "b", "c"]);
  });

  it("keeps a full-site impact even when the chat also edited pages (#627)", () => {
    expect(
      publishChangedPages({
        impact: { pageIds: [], fullSite: true },
        pagesChecked: true,
        editedPageIds: ["b"],
        editedPageLayoutPageIds: [],
      }),
    ).toBeUndefined();
  });

  it("rebuilds everything rather than nothing when no page was collected", () => {
    expect(
      publishChangedPages({
        impact: null,
        pagesChecked: false,
        editedPageIds: ["b"],
        editedPageLayoutPageIds: [],
      }),
    ).toBeUndefined();
  });
});
