// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  type AcceptanceRow,
  acceptedValue,
  groupLiveAcceptances,
} from "./quality-acceptance-groups.js";

function row(over: Partial<AcceptanceRow>): AcceptanceRow {
  return {
    id: "a",
    pageId: "p0",
    pagePath: "/",
    resourcePath: null,
    kind: "check",
    auditId: "seo-check/description-missing",
    category: null,
    acceptedScore: null,
    acceptedCount: 1,
    reason: "legacy archive pages",
    acceptedBy: "u1",
    acceptedAt: "2026-10-14T10:00:00Z",
    revokedAt: null,
    ...over,
  };
}

describe("groupLiveAcceptances (#727 bulk review)", () => {
  it("groups one bulk decision across pages, biggest first, without revoked rows", () => {
    const rows = [
      ...Array.from({ length: 3 }, (_v, i) => row({ id: `c${i}`, pagePath: `/p${i}` })),
      row({ id: "f1", kind: "finding", auditId: "unused-javascript", acceptedScore: 50 }),
      row({ id: "s1", kind: "score", auditId: null, category: "performance", acceptedScore: 88 }),
      row({ id: "old", pagePath: "/gone", revokedAt: "2026-10-14T11:00:00Z" }),
    ];
    const groups = groupLiveAcceptances(rows);
    expect(groups.map((g) => [g.key, g.rows.length])).toEqual([
      ["check:seo-check/description-missing", 3],
      ["finding:unused-javascript", 1],
      ["score:performance", 1],
    ]);
    expect(groups[0]?.reasons).toEqual(["legacy archive pages"]);
    expect(groups[2]?.label).toBe("Performance score below 100");
  });

  it("keeps a site-wide acceptance apart from the per-page ones of the same rule", () => {
    const rows = [
      row({ id: "c1", pageId: "p1", pagePath: "/p1", acceptedCount: 1 }),
      row({ id: "c2", pageId: "p2", pagePath: "/p2", acceptedCount: 3 }),
      row({ id: "site", pageId: null, pagePath: "site-wide", acceptedCount: 2, reason: "infra" }),
    ];
    const groups = groupLiveAcceptances(rows);
    expect(groups.map((g) => [g.key, g.siteWide, g.rows.length, g.values])).toEqual([
      ["check:seo-check/description-missing", false, 2, ["up to 1 error(s)", "up to 3 error(s)"]],
      ["check-site:seo-check/description-missing", true, 1, ["up to 2 error(s)"]],
    ]);
    expect(groups[1]?.reasons).toEqual(["infra"]);
  });

  it("names the accepted value per row", () => {
    expect(acceptedValue(row({ acceptedCount: 3 }))).toBe("up to 3 error(s)");
    expect(acceptedValue(row({ kind: "score", acceptedScore: 88 }))).toBe("score 88");
    expect(acceptedValue(row({ kind: "finding", acceptedScore: null }))).toBe("as recorded");
  });

  it("keeps an audit accepted for a shipped file a site-wide decision of its own (#1446)", () => {
    const file = row({
      id: "f1",
      pageId: null,
      pagePath: "site-wide",
      kind: "finding",
      auditId: "unminified-javascript",
      resourcePath: "/_caelo/plugin/consent-manager/runtime.84de0a18c461.js",
      acceptedScore: 50,
      acceptedCount: null,
    });
    const onPage = row({
      id: "f2",
      kind: "finding",
      auditId: "unminified-javascript",
      acceptedScore: 50,
      acceptedCount: null,
    });
    const groups = groupLiveAcceptances([file, onPage]);
    expect(groups.map((g) => [g.siteWide, g.rows.length])).toEqual(
      expect.arrayContaining([
        [true, 1],
        [false, 1],
      ]),
    );
    expect(groups.find((g) => g.siteWide)?.label).toContain("runtime.84de0a18c461.js");
  });
});
