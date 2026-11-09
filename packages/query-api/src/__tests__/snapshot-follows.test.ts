// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1270 — a cached read at one snapshot is carried forward to a
 * later one only when the later reader saw everything the earlier saw.
 */

import { describe, expect, it } from "bun:test";
import { snapshotFollows } from "../change-journal.js";

describe("snapshotFollows (#1270)", () => {
  it("follows a snapshot taken later", () => {
    expect(snapshotFollows("100:105:101,103", "104:110:107")).toBe(true);
    expect(snapshotFollows("100:105:", "100:105:")).toBe(true);
  });

  it("keeps a transaction in flight earlier still in flight later", () => {
    // 103 was in flight for both: the later reader has seen no less.
    expect(snapshotFollows("100:105:103", "103:106:103")).toBe(true);
  });

  it("refuses an older reader", () => {
    // xmax went back: the earlier snapshot saw 105, the later one did not.
    expect(snapshotFollows("100:106:", "100:105:")).toBe(false);
    // 102 was committed for the earlier snapshot, in flight for the later.
    expect(snapshotFollows("100:105:", "100:110:102")).toBe(false);
  });

  it("throws on a value that is not a snapshot", () => {
    expect(() => snapshotFollows("nope", "100:105:")).toThrow(/not a pg_snapshot/);
  });
});
