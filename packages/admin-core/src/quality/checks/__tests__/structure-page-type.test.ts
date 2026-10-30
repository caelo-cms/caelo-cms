// SPDX-License-Identifier: MPL-2.0

/**
 * #1276 — `structure/unconfirmed-page-type`: pages whose page type nobody
 * chose (the old stored default type) are reported once, site-wide, as a
 * warning naming their paths and the types to choose from.
 */

import { describe, expect, it } from "bun:test";
import { findingSchema } from "../findings.js";
import type { StructurePageIndex } from "../structure-listing.js";
import { unconfirmedPageTypeFindings } from "../structure-page-type.js";

const TYPE_PAGE = "00000000-0000-4000-8000-000000000001";
const TYPE_NEWS = "00000000-0000-4000-8000-000000000002";

function index(pages: [string, boolean][]): StructurePageIndex {
  return {
    pageTypes: new Map([
      [TYPE_PAGE, { slug: "page", name: "Page", purpose: "An ordinary content page" }],
      [TYPE_NEWS, { slug: "news", name: "News", purpose: "Dated company news" }],
    ]),
    pages: new Map(
      pages.map(([path, confirmed], i) => [
        `00000000-0000-4000-9000-${String(i).padStart(12, "0")}`,
        {
          pageTypeId: confirmed ? TYPE_NEWS : TYPE_PAGE,
          pageTypeConfirmed: confirmed,
          title: path,
          path,
        },
      ]),
    ),
    siteHosts: new Set(),
  };
}

describe("structure/unconfirmed-page-type", () => {
  it("is silent when every page has a chosen type", () => {
    expect(unconfirmedPageTypeFindings(index([["/news/a", true]]))).toEqual([]);
  });

  it("reports the unconfirmed pages once, as a warning with paths and types", () => {
    const findings = unconfirmedPageTypeFindings(
      index([
        ["/team", false],
        ["/about", false],
        ["/news/a", true],
      ]),
    );
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(findingSchema.safeParse(f).success).toBe(true);
    expect(f?.severity).toBe("warning");
    expect(f?.pageId).toBeUndefined();
    expect(f?.message).toContain("2 page(s)");
    expect(f?.message).toContain("/about (now page), /team (now page)");
    expect(f?.message).not.toContain("/news/a");
    expect(f?.message).toContain("news (Dated company news)");
    expect(f?.fix?.tool).toBe("update_pages_many");
  });
});
