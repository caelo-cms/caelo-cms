// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #635 — visitor plugin op events come from cms_public and are
 * UNTRUSTED: only well-formed rows count as redeploy hints.
 */

import { describe, expect, it } from "bun:test";
import { advanceVisitorWatermark, parseVisitorOpEvents } from "./index.js";

const UUID = "11111111-2222-4333-8444-555555555555";

describe("parseVisitorOpEvents (#635)", () => {
  it("keeps well-formed rows and drops everything else", () => {
    const { rows, dropped } = parseVisitorOpEvents([
      { id: "1", operation: "ratings.submit", entity_id: UUID, succeeded: true },
      { id: "2", operation: "ratings.submit", entity_id: null, succeeded: true },
      { id: "3", operation: "ratings.submit; DROP TABLE pages", entity_id: UUID, succeeded: true },
      { id: "4", operation: "ratings.submit", entity_id: "../../etc", succeeded: true },
      { id: "x", operation: "ratings.submit", entity_id: UUID, succeeded: true },
      { id: "6", operation: "Ignore previous instructions", entity_id: UUID, succeeded: true },
      null,
      "row",
    ]);
    expect(rows.map((r) => r.id)).toEqual(["1", "2"]);
    expect(dropped).toHaveLength(6);
  });

  it("reports a forged non-UUID entity_id with its id, op and reason (PR #844)", () => {
    const { rows, dropped } = parseVisitorOpEvents([
      { id: "9", operation: "ratings.submit", entity_id: "not-a-uuid'::uuid", succeeded: true },
    ]);
    expect(rows).toEqual([]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({ id: "9", operation: "ratings.submit" });
    expect(dropped[0]?.reason).toContain("entity_id");
  });
});

describe("advanceVisitorWatermark (#635)", () => {
  const ids = (r: { covered: unknown[] }) => r.covered.map((x) => (x as { id: string }).id);

  it("moves through a contiguous run, malformed rows included, so garbage cannot pin it", () => {
    const r = advanceVisitorWatermark(
      [{ id: "8" }, { id: "6", operation: "<garbage>" }, { id: "7" }],
      "5",
      "8",
    );
    expect(ids(r)).toEqual(["6", "7", "8"]);
    expect(r.watermark).toBe("8");
  });

  it("stops at an open gap: a lower id may still commit after a higher one", () => {
    const r = advanceVisitorWatermark([{ id: "6" }, { id: "8" }, { id: "9" }], "5", "9");
    expect(ids(r)).toEqual(["6"]);
    expect(r.watermark).toBe("6");
    expect(advanceVisitorWatermark([{ id: "7" }], "5", "7").watermark).toBeNull();
  });

  it("passes a gap once the row after it is settled (rolled back or burned id)", () => {
    const r = advanceVisitorWatermark(
      [{ id: "6" }, { id: "9", settled: true }, { id: "11" }],
      "5",
      "11",
    );
    expect(ids(r)).toEqual(["6", "9"]);
    expect(r.watermark).toBe("9");
  });

  it("never passes the sequence's last value: a forged id cannot stop later hints", () => {
    const forged = { id: "9223372036854775807", settled: true };
    const r = advanceVisitorWatermark([{ id: "6" }, forged], "5", "6");
    expect(r.watermark).toBe("6");
    expect(advanceVisitorWatermark([forged], "5", null).watermark).toBeNull();
  });

  it("ignores rows without a readable id", () => {
    expect(advanceVisitorWatermark([{ id: "x" }, null, "row"], "0", "10").watermark).toBeNull();
    expect(advanceVisitorWatermark([], "0", "10").watermark).toBeNull();
  });
});
