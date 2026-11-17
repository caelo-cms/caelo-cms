// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  chatContext,
  chatHref,
  type DraftChat,
  initialSelection,
  orderForDisplay,
  stageSelectedLabel,
  statChips,
  totalChanges,
} from "./draft-chats.js";

function chat(id: string, rows: number, extra: Partial<DraftChat> = {}): DraftChat {
  return {
    chatSessionId: id,
    title: `Chat ${id}`,
    branchKind: "draft",
    anchorPageId: null,
    anchorPagePath: null,
    pendingCount: rows * 3,
    summary: {
      newPages: 0,
      changedPages: rows,
      removedPages: 0,
      siteWide: 0,
      rows: Array.from({ length: rows }, (_, i) => ({
        key: `page:${id}-${i}`,
        area: "page" as const,
        change: "changed" as const,
        title: `Page ${i}`,
        path: `/p${i}`,
        what: "Text and images",
        pageId: `${id}-${i}`,
      })),
    },
    ...extra,
  };
}

describe("draft chats", () => {
  it("counts pages and parts, not the entities behind them", () => {
    // pendingCount (entities) is 3x the rows here; the operator sees rows.
    expect(totalChanges([chat("a", 2), chat("b", 5)])).toBe(7);
  });

  it("shows only the counts that are not zero", () => {
    expect(
      statChips({ newPages: 1, changedPages: 4, removedPages: 0, siteWide: 2, rows: [] }),
    ).toEqual(["1 new page", "4 changed pages", "2 site-wide changes"]);
  });

  it("ticks only the conversation on screen when the menu opens", () => {
    const chats = [chat("a", 1), chat("b", 2)];
    expect([...initialSelection(chats, "b")]).toEqual(["b"]);
    // A chat without draft changes is not on the list: nothing ticked.
    expect([...initialSelection(chats, "c")]).toEqual([]);
    expect([...initialSelection(chats, null)]).toEqual([]);
  });

  it("puts the conversation on screen first", () => {
    const ordered = orderForDisplay([chat("a", 1), chat("b", 1), chat("c", 1)], "b");
    expect(ordered.map((c) => c.chatSessionId)).toEqual(["b", "a", "c"]);
  });

  it("offers Stage selected only with several conversations", () => {
    const chats = [chat("a", 1), chat("b", 2)];
    expect(stageSelectedLabel([chat("a", 1)], new Set(["a"]))).toBeNull();
    expect(stageSelectedLabel(chats, new Set())).toEqual({
      label: "Stage selected",
      disabled: true,
    });
    expect(stageSelectedLabel(chats, new Set(["b"]))).toEqual({
      label: "Stage selected (2)",
      disabled: false,
    });
  });

  it("opens a page-bound conversation with its page", () => {
    expect(chatHref(chat("a", 1, { anchorPageId: "p1" }))).toBe("/edit?chat=a&page=p1");
    expect(chatHref(chat("a", 1))).toBe("/edit?chat=a");
  });

  it("says where a conversation works", () => {
    expect(chatContext(chat("a", 1, { anchorPagePath: "/pricing" }))).toBe("/pricing");
    expect(chatContext(chat("a", 1, { branchKind: "experiment" }))).toBe(
      "Experiment · Not tied to a page",
    );
  });
});
