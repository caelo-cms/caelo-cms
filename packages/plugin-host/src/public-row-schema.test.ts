// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #635 — rows a plugin lists from its cms_public tables on the admin
 * side are checked against the plugin's own declaration before its code
 * sees them; anything else is dropped, never coerced.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { sameValue } from "./private-storage.js";
import { validatePublicRows } from "./public-row-schema.js";

const COLUMNS = {
  id: "uuid",
  page_id: "string",
  score: "int",
  status: "enum:pending,approved",
  data: "jsonb",
  created_at: "timestamp",
};
const ID = "11111111-2222-4333-8444-555555555555";

describe("validatePublicRows (#635)", () => {
  it("keeps rows that match the declaration and strips undeclared columns", () => {
    const rows = validatePublicRows("p", "t", COLUMNS, [
      {
        id: ID,
        page_id: "x",
        score: 4,
        status: "pending",
        data: { a: 1 },
        created_at: new Date(),
        extra: "drop me",
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty("extra");
  });

  it("drops rows a compromised public side could have shaped against the plugin", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const rows = validatePublicRows("p", "t", COLUMNS, [
        { id: "not-a-uuid", page_id: "x", score: 1, status: "pending" },
        { id: ID, page_id: "x", score: "4; DROP", status: "pending" },
        { id: ID, page_id: "x", score: 1, status: "approved-by-attacker" },
        { id: ID, page_id: "x".repeat(20_000), score: 1, status: "pending" },
        { id: ID, page_id: { toString: "x" }, score: 1, status: "pending" },
      ]);
      expect(rows).toEqual([]);
      const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("p.t: dropped 5");
      expect(logged).not.toContain("DROP");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("sameValue equality filter helper", () => {
  it("distinguishes null from 'null' and compares objects by JSON structure rather than '[object Object]'", () => {
    expect(sameValue(null, null)).toBe(true);
    expect(sameValue(null, "null")).toBe(false);
    expect(sameValue("null", null)).toBe(false);
    expect(sameValue({ a: 1 }, { b: 2 })).toBe(false);
    expect(sameValue({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(sameValue([1, 2], [1, 3])).toBe(false);
  });
});
