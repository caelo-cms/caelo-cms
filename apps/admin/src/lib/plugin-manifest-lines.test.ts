// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { adminPanelLines, consentPurposeLines, toolbarItemLines } from "./plugin-manifest-lines.js";

describe("plugin manifest summary lines", () => {
  it("keys toolbar items by id, so two items with the same title and permission stay distinct", () => {
    const lines = toolbarItemLines({
      editorToolbar: [
        { id: "a", title: "Languages", permission: "content.edit" },
        { id: "b", title: "Languages", permission: "content.edit" },
      ],
    });
    expect(lines.map((l) => l.text)).toEqual([
      "Languages (needs content.edit)",
      "Languages (needs content.edit)",
    ]);
    expect(new Set(lines.map((l) => l.key)).size).toBe(2);
  });

  it("keys admin panels by slug, so two panels with the same title stay distinct", () => {
    const lines = adminPanelLines({
      adminPanels: [
        { slug: "inbox", title: "Inbox", permission: "content.edit" },
        { slug: "archive", title: "Inbox", permission: "content.edit" },
      ],
    });
    expect(lines).toEqual([
      { key: "inbox", text: "Inbox (needs content.edit)" },
      { key: "archive", text: "Inbox (needs content.edit)" },
    ]);
  });

  it("keys consent purposes by their key and lists the cookies", () => {
    expect(
      consentPurposeLines({
        consentPurposes: [{ key: "stats", category: "analytics", cookies: [{ name: "_id" }] }],
      }),
    ).toEqual([{ key: "stats", text: "stats — analytics (_id)" }]);
  });

  it("answers no lines for a missing or malformed manifest field", () => {
    expect(toolbarItemLines(null)).toEqual([]);
    expect(toolbarItemLines({ editorToolbar: "x" })).toEqual([]);
    expect(adminPanelLines({})).toEqual([]);
    expect(consentPurposeLines({ consentPurposes: [null] })).toEqual([]);
  });
});
