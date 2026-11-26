// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 (decision Q11) — what a change consumer's rebuild chunk answers:
 * done unless it says `done: false`, which needs a new cursor. A shipped
 * rebuild that recomputes everything in one call answers anything else and
 * stays valid; a chunk that cannot be resumed, or does not move, is refused
 * so it cannot loop forever.
 */

import { describe, expect, it } from "bun:test";
import { rebuildChunkOutcome } from "./change-consumers.js";

describe("rebuildChunkOutcome (#1729)", () => {
  it("reads every answer but done: false as done", () => {
    for (const answer of [undefined, null, {}, { done: true }, { lists: { inserted: 3 } }, "ok"]) {
      expect(rebuildChunkOutcome("p", answer, null)).toEqual({ done: true });
    }
  });

  it("continues from the cursor a chunk answers", () => {
    expect(rebuildChunkOutcome("p", { done: false, cursor: "page-200" }, "page-100")).toEqual({
      done: false,
      cursor: "page-200",
    });
  });

  it("refuses done: false without a usable cursor, or with the cursor it was given", () => {
    expect(() => rebuildChunkOutcome("p", { done: false }, null)).toThrow("without a cursor");
    expect(() => rebuildChunkOutcome("p", { done: false, cursor: "" }, null)).toThrow(
      "without a cursor",
    );
    expect(() => rebuildChunkOutcome("p", { done: false, cursor: "x".repeat(4097) }, null)).toThrow(
      "without a cursor",
    );
    expect(() => rebuildChunkOutcome("p", { done: false, cursor: "page-100" }, "page-100")).toThrow(
      "makes no progress",
    );
  });
});
