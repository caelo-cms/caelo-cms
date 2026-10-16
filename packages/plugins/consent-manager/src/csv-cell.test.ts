// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #635 — the consent export carries visitor-written cms_public rows
 * into a file an Owner opens in a spreadsheet: no cell may break the CSV
 * structure or run as a formula.
 */

import { describe, expect, it } from "bun:test";
import { csvCell } from "./index.js";

describe("csvCell (#635)", () => {
  it("quotes every cell and doubles its quotes", () => {
    expect(csvCell("a")).toBe('"a"');
    expect(csvCell('a","b')).toBe('"a"",""b"');
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
  });

  it("keeps a formula as text", () => {
    for (const f of ['=HYPERLINK("x")', "+1", "-1", "@SUM(A1)", "\tx", "\rx"]) {
      expect(csvCell(f).startsWith("\"'")).toBe(true);
    }
  });

  it("writes an empty cell for null", () => {
    expect(csvCell(null)).toBe('""');
  });
});
