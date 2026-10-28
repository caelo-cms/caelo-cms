// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { PluginEditorToolbarItem } from "@caelo-cms/plugin-sdk";
import { toToolbarSlot } from "./plugin-toolbar.js";

const item: PluginEditorToolbarItem = {
  id: "languages",
  title: "Languages",
  icon: "globe",
  operation: "editor_languages",
  permission: "content.read",
  prompts: [{ label: "Translate this page", text: "Translate {page}." }],
};

describe("toToolbarSlot", () => {
  it("passes a valid state through with the declaration's title, icon and prompts", () => {
    const slot = toToolbarSlot("international-site", item, {
      ok: true,
      value: { label: "EN", count: 1, tone: "attention", items: [{ label: "Deutsch" }] },
    });
    expect(slot).toEqual({
      key: "international-site/languages",
      pluginSlug: "international-site",
      title: "Languages",
      icon: "globe",
      prompts: [{ label: "Translate this page", text: "Translate {page}." }],
      state: { label: "EN", count: 1, tone: "attention", items: [{ label: "Deutsch" }] },
      error: null,
    });
  });

  it("leaves the item out when the plugin hides it for this page", () => {
    expect(toToolbarSlot("p", item, { ok: true, value: { hidden: true } })).toBeNull();
  });

  it("keeps a failed operation in the bar with the reason", () => {
    const slot = toToolbarSlot("p", item, { ok: false, message: "locales table missing" });
    expect(slot?.state).toBeNull();
    expect(slot?.error).toBe("The p plugin could not load this: locales table missing");
  });

  it("refuses an answer outside the state schema instead of rendering part of it", () => {
    const slot = toToolbarSlot("p", item, {
      ok: true,
      value: { label: "EN", items: [{ label: "x", html: "<img src=x onerror=alert(1)>" }] },
    });
    expect(slot?.state).toBeNull();
    expect(slot?.error).toContain("answered in a shape the editor cannot show (items.0)");
  });
});
