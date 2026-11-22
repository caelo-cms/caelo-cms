// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1270 — a cached read at one snapshot is carried forward to a
 * later one only when the later reader saw everything the earlier saw.
 */

import { describe, expect, it } from "bun:test";
import { snapshotFollows } from "../change-journal.js";

describe("snapshotFollows (#1270)", () => {
  it("follows a snapshot taken later", () => {
    expect(snapshotFollows("100:105:101,103", "104:110:107", null)).toBe(true);
    expect(snapshotFollows("100:105:", "100:105:", null)).toBe(true);
  });

  it("keeps a transaction in flight earlier still in flight later", () => {
    // 103 was in flight for both: the later reader has seen no less.
    expect(snapshotFollows("100:105:103", "103:106:103", null)).toBe(true);
  });

  it("refuses an older reader", () => {
    // xmax went back: the earlier snapshot saw 105, the later one did not.
    expect(snapshotFollows("100:106:", "100:105:", null)).toBe(false);
    // 102 was committed for the earlier snapshot, in flight for the later.
    expect(snapshotFollows("100:105:", "100:110:102", null)).toBe(false);
  });

  it("counts the marked transaction's own xid as unseen (#1672)", () => {
    // 102 took the earlier snapshot: its own xid is below xmax and not in
    // the in-flight list, yet the cached read saw none of its writes. A
    // reader for which 102 is still in flight has missed nothing.
    expect(snapshotFollows("100:105:", "100:110:102", "102")).toBe(true);
    // Another transaction the earlier snapshot saw committed still refuses.
    expect(snapshotFollows("100:105:", "100:110:102,103", "102")).toBe(false);
  });

  it("throws on a value that is not a snapshot", () => {
    expect(() => snapshotFollows("nope", "100:105:", null)).toThrow(/not a pg_snapshot/);
  });
});
