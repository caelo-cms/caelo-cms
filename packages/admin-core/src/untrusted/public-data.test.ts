// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it, spyOn } from "bun:test";
import { z } from "zod";
import {
  parseUntrustedRows,
  untrustedOperation,
  untrustedSlug,
  untrustedTimestamp,
} from "./public-data.js";

describe("parseUntrustedRows (#635: public → admin data is untrusted)", () => {
  const schema = z.object({ slug: untrustedSlug, op: untrustedOperation, at: untrustedTimestamp });

  it("keeps rows that fit, drops and counts the rest, never logs their content", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const r = parseUntrustedRows("test.boundary", schema, [
        { slug: "comments", op: "submit", at: new Date("2026-01-01T00:00:00Z") },
        { slug: "<script>alert(1)</script>", op: "submit", at: "2026-01-01" },
        { slug: "comments", op: "submit", at: "not a date" },
        { slug: "x".repeat(200), op: "submit", at: "2026-01-01" },
      ]);
      expect(r.rows).toEqual([{ slug: "comments", op: "submit", at: "2026-01-01T00:00:00.000Z" }]);
      expect(r.dropped).toBe(3);
      const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("test.boundary: dropped 3");
      expect(logged).not.toContain("script");
    } finally {
      warn.mockRestore();
    }
  });
});
