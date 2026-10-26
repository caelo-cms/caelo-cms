// SPDX-License-Identifier: MPL-2.0

/**
 * The declared consent purposes come from the host's registry of loaded,
 * enabled plugins, tagged with the slug each was loaded under.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { PluginConsentPurpose, PluginDefinition } from "@caelo-cms/plugin-sdk";
import {
  consentPurposeDeclared,
  declaredConsentPurposes,
  makePluginConsentPurposes,
  pluginDeclaresConsentPurpose,
} from "./consent-purposes.js";
import {
  type LoadedPlugin,
  loadedPlugins,
  resetDisabledSet,
  setPluginDisabled,
} from "./dispatch.js";

const VISITOR_ID: PluginConsentPurpose = {
  key: "visitor_id",
  category: "functional",
  purpose: "One rating per visitor.",
  cookies: [{ name: "caelo_visitor_id", lifetime: "30 days", purpose: "Remembers it." }],
};

function load(slug: string, consentPurposes?: PluginConsentPurpose[]): void {
  const definition: PluginDefinition = {
    slug,
    version: "1.0.0",
    tier: 1,
    schema: {},
    operations: {},
    ...(consentPurposes ? { consentPurposes } : {}),
  };
  const plugin: LoadedPlugin = {
    pluginId: crypto.randomUUID(),
    slug,
    version: "1.0.0",
    tier: 1,
    provenance: "release-signed",
    definition,
    pluginActorId: crypto.randomUUID(),
  };
  loadedPlugins.set(plugin);
}

afterEach(() => {
  loadedPlugins.reset();
  resetDisabledSet();
});

describe("declaredConsentPurposes", () => {
  it("lists every loaded plugin's purposes, tagged by the host with its slug", async () => {
    load("ratings", [VISITOR_ID]);
    load("forms");
    load("analytics-x", [{ ...VISITOR_ID, key: "page_views", category: "analytics", cookies: [] }]);
    const list = await makePluginConsentPurposes().list();
    expect(list.map((p) => [p.pluginSlug, p.key, p.category])).toEqual([
      ["analytics-x", "page_views", "analytics"],
      ["ratings", "visitor_id", "functional"],
    ]);
    expect(consentPurposeDeclared("visitor_id")).toBe(true);
  });

  it("answers per plugin: one plugin's declaration opens nothing to another", () => {
    load("ratings", [VISITOR_ID]);
    load("forms");
    expect(pluginDeclaresConsentPurpose("ratings", "visitor_id")).toBe(true);
    expect(pluginDeclaresConsentPurpose("forms", "visitor_id")).toBe(false);
    expect(pluginDeclaresConsentPurpose("consent-manager", "visitor_id")).toBe(false);
  });

  it("drops a disabled plugin's purposes, and with them the visitor-id purpose", () => {
    load("ratings", [VISITOR_ID]);
    setPluginDisabled("ratings", true);
    expect(declaredConsentPurposes()).toEqual([]);
    expect(consentPurposeDeclared("visitor_id")).toBe(false);
  });

  it("hands out frozen copies a consumer cannot rewrite for the next one", () => {
    load("ratings", [VISITOR_ID]);
    const list = declaredConsentPurposes() as unknown as Array<Record<string, unknown>>;
    expect(() => {
      (list[0] as { category: string }).category = "marketing";
    }).toThrow();
    expect(() => list.push({})).toThrow();
    expect(declaredConsentPurposes()[0]?.category).toBe("functional");
  });
});
