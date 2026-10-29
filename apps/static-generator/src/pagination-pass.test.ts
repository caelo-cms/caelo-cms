// SPDX-License-Identifier: MPL-2.0

/** #1257 — the build's guards for paginated overviews and their follow-up pages' head. */

import { describe, expect, it } from "bun:test";
import type { ListPaginationState } from "@caelo-cms/shared";
import { assertPaginationRenderable, followUpCollisionError } from "./pagination-pass.js";
import { followUpHeadEntries } from "./seo-pass.js";

const state = (extra: Partial<ListPaginationState> = {}): ListPaginationState => ({
  field: "guides",
  perPage: 20,
  total: 55,
  pageCount: 3,
  page: 1,
  followUps: "index",
  pagerShown: true,
  pagerEarly: false,
  ...extra,
});
const PAGE = { page_id: "00000000-0000-4000-8000-000000000001", slug: "guides" };

describe("assertPaginationRenderable", () => {
  it("passes a sequence with a pager, and a list that fits on one page", () => {
    expect(() => assertPaginationRenderable(PAGE, state(), null)).not.toThrow();
    expect(() =>
      assertPaginationRenderable(PAGE, state({ pageCount: 1, pagerShown: false }), null),
    ).not.toThrow();
    expect(() => assertPaginationRenderable(PAGE, null, null)).not.toThrow();
  });

  it("refuses several pages without a pager and names the fix", () => {
    expect(() => assertPaginationRenderable(PAGE, state({ pagerShown: false }), null)).toThrow(
      /entries 21–55 would be unreachable.*pagination/,
    );
  });

  it("refuses a paginated 404 page", () => {
    expect(() => assertPaginationRenderable(PAGE, state(), PAGE.page_id)).toThrow(/404 page/);
  });
});

describe("followUpCollisionError", () => {
  it("names a page sitting where the follow-up pages go", () => {
    const msg = followUpCollisionError(
      [{ path: "/guides", slug: "guides" }],
      ["/guides", "/guides/page", "/guides/intro"],
    );
    expect(msg).toContain('/guides/page (under overview "guides")');
    expect(msg).not.toContain("/guides/intro");
  });

  it("is null without a collision", () => {
    expect(followUpCollisionError([{ path: "/", slug: "home" }], ["/", "/pages"])).toBeNull();
  });
});

describe("followUpHeadEntries", () => {
  it("drops hreflang alternates — they are page 1's twins — and keeps the rest", () => {
    const entries = [
      { kind: "link" as const, rel: "alternate", href: "https://x/de/guides/", hreflang: "de" },
      { kind: "link" as const, rel: "preconnect", href: "https://cdn.example" },
      { kind: "meta" as const, name: "theme-color", content: "#000" },
    ];
    expect(followUpHeadEntries(entries)).toEqual([entries[1], entries[2]]);
    expect(followUpHeadEntries(undefined)).toBeUndefined();
  });
});
