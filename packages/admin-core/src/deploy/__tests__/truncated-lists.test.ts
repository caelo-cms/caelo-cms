// SPDX-License-Identifier: MPL-2.0

/** #1257 — the Stage warning for page lists cut at the query cap. */

import { describe, expect, it } from "bun:test";
import {
  describeTruncatedLists,
  TRUNCATED_LISTS_LISTED,
  truncatedListSchema,
} from "../truncated-lists.js";

const cut = (n: number) => ({
  pageSlug: `p${n}`,
  pagePath: `/p${n}`,
  field: "guides",
  shown: 50,
  total: 63,
  limit: 50,
});

describe("describeTruncatedLists", () => {
  it("is null when nothing is cut", () => {
    expect(describeTruncatedLists([])).toBeNull();
  });

  it("says what is cut and how to list every page", () => {
    const msg = describeTruncatedLists([cut(1)]);
    expect(msg).toContain('/p1 "guides" shows 50 of 63');
    expect(msg).toContain("paginate");
  });

  it("names the first lists and counts the rest", () => {
    const many = Array.from({ length: TRUNCATED_LISTS_LISTED + 2 }, (_, i) => cut(i));
    const msg = describeTruncatedLists(many) ?? "";
    expect(msg).toContain(`${TRUNCATED_LISTS_LISTED + 2} page list(s)`);
    expect(msg).toContain("and 2 more");
  });

  it("parses the generator's report strictly", () => {
    expect(truncatedListSchema.safeParse(cut(1)).success).toBe(true);
    expect(truncatedListSchema.safeParse({ ...cut(1), extra: 1 }).success).toBe(false);
  });
});
