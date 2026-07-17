// SPDX-License-Identifier: MPL-2.0

/**
 * renderToonList — the uniform list surface every read tool shares:
 * TOON output (header + CSV-ish rows), case-insensitive substring
 * `filter`, `limit`/`offset` pagination, char-cap truncation, and the
 * `full` flag that disables truncation entirely.
 */

import { describe, expect, it } from "bun:test";
import { renderToonList } from "../tools/_make-read-tool.js";

const rows = Array.from({ length: 120 }, (_v, i) => ({
  slug: `page-${i}`,
  title: i === 7 ? 'Say "hi", world' : `Title ${i}`,
}));

const columns = [
  { key: "slug", value: (r: (typeof rows)[number]) => r.slug },
  { key: "title", value: (r: (typeof rows)[number]) => r.title },
];

describe("renderToonList", () => {
  it("renders TOON: header with count + column keys, comma rows", () => {
    const out = renderToonList("pages", rows.slice(0, 3), columns, {});
    expect(out).toContain("pages[3]{slug,title}:");
    expect(out).toContain("  page-0,Title 0");
  });

  it("CSV-escapes cells containing commas or quotes", () => {
    const out = renderToonList("pages", rows.slice(7, 8), columns, {});
    expect(out).toContain('"Say ""hi"", world"');
  });

  it("applies the default limit (50) and emits an actionable footer", () => {
    const out = renderToonList("pages", rows, columns, {});
    expect(out).toContain("pages[50]{");
    expect(out).toContain("50 of 120 shown");
    expect(out).toContain("offset=50");
    expect(out).toContain("full=true");
  });

  it("offset pages through; limit caps the page", () => {
    const out = renderToonList("pages", rows, columns, { offset: 100, limit: 10 });
    expect(out).toContain("pages[10]{");
    expect(out).toContain("  page-100,");
    expect(out).toContain("offset=110");
  });

  it("filter matches case-insensitively across all columns", () => {
    const out = renderToonList("pages", rows, columns, { filter: "TITLE 11" });
    // Title 11, 110..119 — 11 matches.
    expect(out).toContain("pages[11]{");
    expect(out).toContain('filter="TITLE 11"');
    expect(out).not.toContain("page-0,");
  });

  it("full=true disables both the row limit and the char cap", () => {
    const out = renderToonList("pages", rows, columns, { full: true });
    expect(out).toContain("pages[120]{");
    expect(out).not.toContain("full=true disables"); // no truncation footer
  });

  it("char cap truncates on whole rows and says how to continue", () => {
    const big = Array.from({ length: 30 }, (_v, i) => ({
      slug: `s${i}`,
      title: "x".repeat(400),
    }));
    const out = renderToonList("pages", big, columns, { limit: 500 });
    // 6000-char cap → ~14 rows of ~405 chars.
    const shown = Number(/pages\[(\d+)\]/.exec(out)?.[1]);
    expect(shown).toBeGreaterThan(5);
    expect(shown).toBeLessThan(30);
    expect(out).toContain("full=true");
  });
});
