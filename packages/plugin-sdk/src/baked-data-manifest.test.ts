// SPDX-License-Identifier: MPL-2.0

/**
 * #1155 — the `bakedData` declaration: what the manifest accepts, and that
 * the one projection (`manifestFromDefinition`) carries it into the signed
 * manifest.
 */

import { describe, expect, it } from "bun:test";
import { manifestFromDefinition, type PluginBakedData, pluginManifest } from "./index.js";

const BAKED: PluginBakedData = {
  description: "Approved comments, baked into their page.",
  triggers: [{ operation: "moderate", pageIds: { from: "result", key: "pageId" } }],
};

function manifest(extra: Record<string, unknown>) {
  return pluginManifest.safeParse({
    slug: "guestbook",
    version: "1.0.0",
    tier: 1,
    schema: {},
    operations: ["moderate", "submit"],
    hasStaticRender: true,
    ...extra,
  });
}

function messages(r: ReturnType<typeof manifest>): string {
  return r.success ? "" : r.error.issues.map((i) => i.message).join("\n");
}

describe("pluginManifest — bakedData", () => {
  it("accepts a declaration whose triggers are operations of a plugin with a staticRender", () => {
    expect(manifest({ bakedData: BAKED }).success).toBe(true);
  });

  it("refuses a trigger the plugin does not have", () => {
    const r = manifest({
      bakedData: {
        ...BAKED,
        triggers: [{ operation: "approve", pageIds: { from: "args", key: "pageId" } }],
      },
    });
    expect(messages(r)).toContain(
      'bakedData trigger "approve" is not one of the plugin\'s operations',
    );
  });

  it("refuses a declaration without a staticRender", () => {
    expect(messages(manifest({ hasStaticRender: false, bakedData: BAKED }))).toContain(
      "bakedData needs a staticRender",
    );
  });

  it("refuses a malformed key or source and unknown fields", () => {
    for (const pageIds of [
      { from: "body", key: "pageId" },
      { from: "args", key: "page.id" },
      { from: "args", key: "pageId", extra: true },
    ]) {
      const r = manifest({
        bakedData: { ...BAKED, triggers: [{ operation: "moderate", pageIds }] },
      });
      expect(r.success).toBe(false);
    }
    expect(manifest({ bakedData: { ...BAKED, pages: "all" } }).success).toBe(false);
    expect(manifest({ bakedData: { ...BAKED, triggers: [] } }).success).toBe(false);
  });
});

describe("manifestFromDefinition — bakedData", () => {
  it("carries the declaration into the manifest", () => {
    const m = manifestFromDefinition({
      slug: "guestbook",
      version: "1.0.0",
      tier: 1,
      schema: {},
      operations: { moderate: async () => ({}) },
      staticRender: async () => "",
      bakedData: BAKED,
    });
    expect(m.bakedData).toEqual(BAKED);
  });
});
