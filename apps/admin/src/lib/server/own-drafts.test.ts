// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { readAllPages } from "./own-drafts.js";

describe("readAllPages", () => {
  it("follows the cursor past the first page (Codex #1643: an older chat dropped out)", async () => {
    const pages: Record<string, { chats: number[]; nextCursor: string | null }> = {
      first: { chats: [1, 2], nextCursor: "c2" },
      c2: { chats: [3, 4], nextCursor: "c3" },
      c3: { chats: [5], nextCursor: null },
    };
    const asked: (string | undefined)[] = [];
    const all = await readAllPages(async (cursor) => {
      asked.push(cursor);
      const page = pages[cursor ?? "first"];
      if (!page) throw new Error(`no page ${cursor}`);
      return page;
    });
    expect(all).toEqual([1, 2, 3, 4, 5]);
    expect(asked).toEqual([undefined, "c2", "c3"]);
  });

  it("stops loudly on a cursor it was already given", async () => {
    await expect(readAllPages(async () => ({ chats: [1], nextCursor: "same" }))).rejects.toThrow(
      "same page cursor twice",
    );
  });
});
