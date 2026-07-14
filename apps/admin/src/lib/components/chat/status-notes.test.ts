// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { collapseStatusNotes, statusNoteKey } from "./status-notes.js";
import type { ChatMessage } from "./types.js";

let seq = 0;
function msg(partial: Partial<ChatMessage>): ChatMessage {
  return { id: `m-${seq++}`, role: "user", content: "x", ...partial };
}
function note(content: string): ChatMessage {
  return msg({ role: "user", origin: "system", content });
}

describe("statusNoteKey", () => {
  it("normalises digit ticks so progress updates compare equal", () => {
    expect(statusNoteKey("Crawling… 5/50 pages (10%)")).toBe(
      statusNoteKey("Crawling… 12/50 pages (24%)"),
    );
  });

  it("normalises run-id / proposal-id prefixes", () => {
    expect(statusNoteKey("Approved: crawl proposal 3f9a12bc — starting")).toBe(
      statusNoteKey("Approved: crawl proposal a0b1c2d3 — starting"),
    );
  });

  it("keeps genuinely different statuses distinct", () => {
    expect(statusNoteKey("Crawl finished: run 3f9a12bc reached ready_for_review")).not.toBe(
      statusNoteKey("Crawl failed: run 3f9a12bc — timeout"),
    );
  });
});

describe("collapseStatusNotes (issue #303)", () => {
  it("passes non-status messages through untouched", () => {
    const input = [
      msg({ role: "user", content: "build me a site" }),
      msg({ role: "assistant", content: "on it" }),
      msg({ role: "tool", content: "ok", toolName: "edit_module" }),
    ];
    expect(collapseStatusNotes(input)).toEqual(input);
  });

  it("drops status notes with empty/whitespace bodies (legacy rows)", () => {
    const keep = note("Crawl finished: 12 pages staged.");
    const result = collapseStatusNotes([note(""), keep, note("   \n ")]);
    expect(result).toEqual([keep]);
  });

  it("collapses consecutive near-identical crawl ticks to the LAST one", () => {
    const t1 = note("Crawling… 5/50 pages");
    const t2 = note("Crawling… 12/50 pages");
    const t3 = note("Crawling… 31/50 pages");
    expect(collapseStatusNotes([t1, t2, t3])).toEqual([t3]);
  });

  it("does not collapse distinct consecutive statuses", () => {
    const a = note("Crawling… 31/50 pages");
    const b = note("Crawl finished: run 3f9a12bc reached ready_for_review (31 pages staged).");
    expect(collapseStatusNotes([a, b])).toEqual([a, b]);
  });

  it("a non-status message between ticks breaks the run", () => {
    const t1 = note("Crawling… 5/50 pages");
    const reply = msg({ role: "assistant", content: "still waiting on the crawler" });
    const t2 = note("Crawling… 12/50 pages");
    expect(collapseStatusNotes([t1, reply, t2])).toEqual([t1, reply, t2]);
  });

  it("operator-typed user messages are never treated as status notes", () => {
    const a = msg({ role: "user", content: "same text" });
    const b = msg({ role: "user", content: "same text" });
    expect(collapseStatusNotes([a, b])).toEqual([a, b]);
  });
});
