// SPDX-License-Identifier: MPL-2.0

/**
 * issue #264 — unit coverage for the per-page log's pure logic: the shared
 * append-input schema (the same one the op + tool validate against) and the
 * `formatPageLogBlock` context-block renderer (non-empty gate, entry cap,
 * <2 KB budget).
 */

import { describe, expect, it } from "bun:test";
import { formatPageLogBlock, type PageLogEntry, pageLogAppendInputSchema } from "./page-log.js";

const PAGE = "11111111-1111-4111-8111-aaaaaaaaaaaa";

function entry(over: Partial<PageLogEntry>): PageLogEntry {
  return {
    id: "22222222-2222-4222-8222-bbbbbbbbbbbb",
    pageId: PAGE,
    chatSessionId: null,
    actorKind: "ai",
    entryKind: "decision",
    summary: "Chose a two-column hero to match the source layout.",
    detail: null,
    createdAt: "2026-07-13T10:00:00.000Z",
    ...over,
  };
}

describe("pageLogAppendInputSchema", () => {
  it("accepts a minimal valid payload (no detail)", () => {
    const r = pageLogAppendInputSchema.safeParse({
      pageId: PAGE,
      entryKind: "operator_answer",
      summary: "Operator said keep the original blue, not the refreshed teal.",
    });
    expect(r.success).toBe(true);
  });

  it("accepts an object detail and every entry kind", () => {
    for (const entryKind of [
      "edited",
      "decision",
      "operator_answer",
      "open_question",
      "rebuilt",
      "note",
    ] as const) {
      const r = pageLogAppendInputSchema.safeParse({
        pageId: PAGE,
        entryKind,
        summary: "x",
        detail: { chosen: "blue", operatorWords: "keep the blue" },
      });
      expect(r.success).toBe(true);
    }
  });

  it("rejects an unknown entry kind, an empty summary, and a bad page id", () => {
    expect(
      pageLogAppendInputSchema.safeParse({ pageId: PAGE, entryKind: "deleted", summary: "x" })
        .success,
    ).toBe(false);
    expect(
      pageLogAppendInputSchema.safeParse({ pageId: PAGE, entryKind: "note", summary: "" }).success,
    ).toBe(false);
    expect(
      pageLogAppendInputSchema.safeParse({ pageId: "not-a-uuid", entryKind: "note", summary: "x" })
        .success,
    ).toBe(false);
  });

  it("rejects unknown keys (strict) and a non-object detail", () => {
    expect(
      pageLogAppendInputSchema.safeParse({
        pageId: PAGE,
        entryKind: "note",
        summary: "x",
        extra: 1,
      }).success,
    ).toBe(false);
    expect(
      pageLogAppendInputSchema.safeParse({
        pageId: PAGE,
        entryKind: "note",
        summary: "x",
        detail: "a bare string",
      }).success,
    ).toBe(false);
  });
});

describe("formatPageLogBlock", () => {
  it("returns null for an empty log so the header is omitted", () => {
    expect(formatPageLogBlock([])).toBeNull();
  });

  it("renders the header, primer, and one line per entry newest-first", () => {
    const block = formatPageLogBlock([
      entry({ entryKind: "rebuilt", summary: "Rebuilt from the imported source." }),
      entry({ entryKind: "operator_answer", summary: "Keep the blue.", actorKind: "human" }),
    ]);
    expect(block).not.toBeNull();
    const b = block as string;
    expect(b).toContain("## Page log");
    expect(b).toContain("log_page_edit");
    expect(b).toContain("- [rebuilt] Rebuilt from the imported source. (AI, 2026-07-13)");
    expect(b).toContain("- [operator_answer] Keep the blue. (operator, 2026-07-13)");
  });

  it("caps the entry list and stays under 2 KB even with long summaries", () => {
    const many: PageLogEntry[] = Array.from({ length: 40 }, (_, i) =>
      entry({ id: `id-${i}`, summary: "Q".repeat(500) }),
    );
    const block = formatPageLogBlock(many) as string;
    // 8 shown + a truncation notice line.
    expect(block).toContain("older entr");
    expect((block.match(/^- \[/gm) ?? []).length).toBe(8);
    expect(Buffer.byteLength(block, "utf8")).toBeLessThan(2048);
  });
});
