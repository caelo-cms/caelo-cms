// SPDX-License-Identifier: MPL-2.0

/**
 * #724 — the Stage warning for links to pages a build does not contain,
 * and the shape the generator's report must have at the admin boundary.
 */

import { describe, expect, it } from "bun:test";
import {
  describeUnpublishedLinks,
  UNPUBLISHED_LINKS_LISTED,
  type UnpublishedLinkTarget,
  unpublishedLinkTargetSchema,
} from "../unpublished-links.js";

const TARGET = "22222222-2222-4222-8222-222222222222";

function link(i: number): UnpublishedLinkTarget {
  return { pageSlug: `p${i}`, pagePath: `/p${i}`, targetPageId: TARGET, targetUrl: "/soon/" };
}

describe("describeUnpublishedLinks", () => {
  it("says nothing when every linked page is in the build", () => {
    expect(describeUnpublishedLinks([])).toBeNull();
  });

  it("names each link and the next step", () => {
    const text = describeUnpublishedLinks([link(1)]);
    expect(text).toContain("1 link(s) point to draft pages");
    expect(text).toContain("/p1 → /soon/");
    expect(text).toContain("set_pages_status_many");
  });

  it("lists a bounded number and keeps the exact count", () => {
    const many = Array.from({ length: UNPUBLISHED_LINKS_LISTED + 3 }, (_, i) => link(i));
    const text = describeUnpublishedLinks(many) ?? "";
    expect(text).toContain(`${many.length} link(s)`);
    expect(text).toContain("and 3 more");
    expect(text).not.toContain(`/p${UNPUBLISHED_LINKS_LISTED} →`);
  });
});

describe("unpublishedLinkTargetSchema", () => {
  it("rejects a report that is not the generator's shape", () => {
    expect(unpublishedLinkTargetSchema.safeParse(link(1)).success).toBe(true);
    expect(
      unpublishedLinkTargetSchema.safeParse({ ...link(1), targetPageId: "not-a-uuid" }).success,
    ).toBe(false);
    expect(unpublishedLinkTargetSchema.safeParse({ ...link(1), extra: 1 }).success).toBe(false);
  });
});
