// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  manifestFromDefinition,
  type PluginEditorToolbarItem,
  pluginEditorToolbarState,
  pluginManifest,
} from "./index.js";

const base = {
  slug: "langs",
  version: "1.0.0",
  tier: 2 as const,
  schema: {},
  operations: ["editor_languages", "translate"],
  hasStaticRender: false,
};

const item: PluginEditorToolbarItem = {
  id: "languages",
  title: "Languages",
  icon: "globe",
  operation: "editor_languages",
  permission: "content.read",
  prompts: [{ label: "Translate this page", text: "Translate {page} into every language." }],
};

function issues(manifest: unknown): string[] {
  const r = pluginManifest.safeParse(manifest);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}

describe("editorToolbar in the manifest", () => {
  it("accepts a declared item", () => {
    expect(issues({ ...base, editorToolbar: [item] })).toEqual([]);
  });

  it("refuses an operation the plugin does not declare", () => {
    expect(issues({ ...base, editorToolbar: [{ ...item, operation: "nope" }] })).toEqual([
      'editorToolbar.0.operation: operation "nope" is not one of the plugin\'s operations',
    ]);
  });

  it("refuses an item id declared twice", () => {
    expect(issues({ ...base, editorToolbar: [item, item] })).toEqual([
      'editorToolbar.1.id: toolbar item "languages" is declared twice',
    ]);
  });

  it("refuses two prompts with the same label in one item", () => {
    const prompt = { label: "Translate", text: "Translate {page}." };
    expect(issues({ ...base, editorToolbar: [{ ...item, prompts: [prompt, prompt] }] })).toEqual([
      'editorToolbar.0.prompts.1.label: prompt "Translate" is declared twice',
    ]);
  });

  it("allows at most two items per plugin", () => {
    const three = ["a", "b", "c"].map((id) => ({ ...item, id }));
    expect(issues({ ...base, editorToolbar: three }).length).toBeGreaterThan(0);
  });

  it("refuses unknown keys, so no field can smuggle markup or code in", () => {
    expect(issues({ ...base, editorToolbar: [{ ...item, html: "<b>x</b>" }] }).length).toBe(1);
  });

  it("is carried from the definition into the manifest", () => {
    const manifest = manifestFromDefinition({
      slug: base.slug,
      version: base.version,
      tier: 2,
      schema: {},
      operations: { editor_languages: async () => ({}), translate: async () => ({}) },
      editorToolbar: [item],
    });
    expect(manifest.editorToolbar).toEqual([item]);
  });
});

describe("pluginEditorToolbarState", () => {
  it("accepts a full state", () => {
    const state = {
      label: "EN",
      count: 2,
      tone: "attention",
      summary: "Two languages need work.",
      items: [
        { label: "English", detail: "Source", current: true },
        {
          label: "Deutsch",
          detail: "Out of date",
          tone: "attention",
          pageId: "0b9c6d3e-2a52-4c7e-9d3f-6a1b2c3d4e5f",
        },
      ],
    };
    expect(pluginEditorToolbarState.parse(state)).toEqual(state as never);
  });

  it("refuses a label longer than a short code", () => {
    expect(pluginEditorToolbarState.safeParse({ label: "English (US)" }).success).toBe(false);
  });

  it("refuses a page link that is not a page id", () => {
    const r = pluginEditorToolbarState.safeParse({
      items: [{ label: "Deutsch", pageId: "https://example.com" }],
    });
    expect(r.success).toBe(false);
  });
});
