// SPDX-License-Identifier: MPL-2.0

/**
 * Unit tests for the pure text engine behind read_content / edit_content /
 * grep_content. This is where the Claude-Code Edit invariants live
 * (uniqueness, atomicity, not-found, replaceAll) — the tool handlers are thin
 * glue over the Query API, so pinning the engine here is the load-bearing
 * coverage.
 */

import { describe, expect, it } from "bun:test";
import {
  applyStringEdits,
  contentSha,
  grepBody,
  renderEditSnippet,
  renderWithLineNumbers,
} from "../text-ops.js";

describe("applyStringEdits", () => {
  it("applies a single unique replacement", () => {
    const r = applyStringEdits("<h1>Hello</h1>", [{ oldString: "Hello", newString: "Hi" }]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.content).toBe("<h1>Hi</h1>");
      expect(r.replacements).toBe(1);
    }
  });

  it("rejects a not-found oldString with a re-read hint", () => {
    const r = applyStringEdits("abc", [{ oldString: "xyz", newString: "q" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not found");
  });

  it("rejects a non-unique oldString unless replaceAll", () => {
    const r = applyStringEdits("a a a", [{ oldString: "a", newString: "b" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("3 matches");
  });

  it("replaceAll changes every occurrence and counts them", () => {
    const r = applyStringEdits("a a a", [{ oldString: "a", newString: "b", replaceAll: true }]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.content).toBe("b b b");
      expect(r.replacements).toBe(3);
    }
  });

  it("rejects oldString === newString", () => {
    const r = applyStringEdits("abc", [{ oldString: "a", newString: "a" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("nothing to change");
  });

  it("applies multiple edits sequentially against the running string", () => {
    const r = applyStringEdits("one two three", [
      { oldString: "one", newString: "1" },
      { oldString: "two", newString: "2" },
      { oldString: "three", newString: "3" },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toBe("1 2 3");
  });

  it("is atomic: a later failing edit reverts the whole batch (no partial write)", () => {
    const r = applyStringEdits("keep me", [
      { oldString: "keep", newString: "changed" },
      { oldString: "NOPE", newString: "x" },
    ]);
    expect(r.ok).toBe(false);
    // On failure the caller persists nothing — the returned shape carries no content.
    if (!r.ok) expect(r.error).toContain("edit #2");
  });

  it("lets a later edit target text introduced by an earlier one", () => {
    const r = applyStringEdits("foo", [
      { oldString: "foo", newString: "bar" },
      { oldString: "bar", newString: "baz" },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toBe("baz");
  });

  it("rejects an empty edits array", () => {
    const r = applyStringEdits("x", []);
    expect(r.ok).toBe(false);
  });
});

describe("contentSha", () => {
  it("is stable and change-sensitive", () => {
    expect(contentSha("hello")).toBe(contentSha("hello"));
    expect(contentSha("hello")).not.toBe(contentSha("hello!"));
  });
});

describe("renderWithLineNumbers", () => {
  it("prefixes cat -n style line numbers", () => {
    const r = renderWithLineNumbers("a\nb\nc");
    expect(r.totalLines).toBe(3);
    expect(r.shownLines).toBe(3);
    expect(r.text.split("\n")[0]).toBe(`${"1".padStart(6)}\ta`);
  });

  it("windows via offset + limit and reports the range", () => {
    const r = renderWithLineNumbers("l1\nl2\nl3\nl4\nl5", { offset: 2, limit: 2 });
    expect(r.startLine).toBe(2);
    expect(r.endLine).toBe(3);
    expect(r.shownLines).toBe(2);
    expect(r.text).toContain("l2");
    expect(r.text).toContain("l3");
    expect(r.text).not.toContain("l4");
  });

  it("handles an offset past the end", () => {
    const r = renderWithLineNumbers("only", { offset: 99 });
    expect(r.shownLines).toBe(0);
    expect(r.text).toBe("");
  });
});

describe("renderEditSnippet", () => {
  const body = ["line1", "line2", "target", "line4", "line5", "line6", "line7", "line8"].join("\n");

  it("renders a cat -n window around a single edit", () => {
    const snip = renderEditSnippet(body, [{ oldString: "x", newString: "target" }], { context: 1 });
    // ±1 line around line 3 → lines 2..4, line-numbered.
    expect(snip).toContain(`${"2".padStart(6)}\tline2`);
    expect(snip).toContain(`${"3".padStart(6)}\ttarget`);
    expect(snip).toContain(`${"4".padStart(6)}\tline4`);
    expect(snip).not.toContain("line6");
  });

  it("merges overlapping windows into one block (no duplicate marker)", () => {
    // Two edits on adjacent lines → their ±context windows overlap → one block.
    const snip = renderEditSnippet(
      "a\nHIT1\nHIT2\nb\nc",
      [
        { oldString: "x", newString: "HIT1" },
        { oldString: "y", newString: "HIT2" },
      ],
      { context: 1 },
    );
    expect(snip).not.toContain("⋮");
    expect(snip).toContain("HIT1");
    expect(snip).toContain("HIT2");
  });

  it("separates non-contiguous windows with a marker", () => {
    const long = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join("\n");
    const withHits = long.replace("l2", "AA").replace("l18", "BB");
    const snip = renderEditSnippet(
      withHits,
      [
        { oldString: "x", newString: "AA" },
        { oldString: "y", newString: "BB" },
      ],
      { context: 1 },
    );
    expect(snip).toContain("⋮");
    expect(snip).toContain("AA");
    expect(snip).toContain("BB");
  });

  it("returns empty when newString cannot be located (pure deletion)", () => {
    expect(renderEditSnippet("abc", [{ oldString: "b", newString: "" }])).toBe("");
  });
});

describe("grepBody", () => {
  it("finds literal substring matches with line numbers", () => {
    const g = grepBody("alpha\nbeta\nalphabet", "alpha");
    expect(g.ok).toBe(true);
    if (g.ok) {
      expect(g.hits.map((h) => h.lineNumber)).toEqual([1, 3]);
    }
  });

  it("honours ignoreCase", () => {
    const g = grepBody("Hello", "hello", { ignoreCase: true });
    expect(g.ok).toBe(true);
    if (g.ok) expect(g.hits).toHaveLength(1);
  });

  it("compiles a regex when isRegex is set", () => {
    const g = grepBody("id-1\nid-22\nx", "id-\\d+", { isRegex: true });
    expect(g.ok).toBe(true);
    if (g.ok) expect(g.hits).toHaveLength(2);
  });

  it("returns a loud error for an invalid regex", () => {
    const g = grepBody("x", "(", { isRegex: true });
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.error).toContain("invalid regex");
  });
});
