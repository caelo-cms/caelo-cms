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
    pagePath: "/",
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

  it("names the accepted value per row", () => {
    expect(acceptedValue(row({ acceptedCount: 3 }))).toBe("up to 3 error(s)");
    expect(acceptedValue(row({ kind: "score", acceptedScore: 88 }))).toBe("score 88");
    expect(acceptedValue(row({ kind: "finding", acceptedScore: null }))).toBe("as recorded");
  });
});
