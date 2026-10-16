// SPDX-License-Identifier: MPL-2.0

/**
 * Guard for the one source `loadSiteFontUsage` cannot read: Tier-1
 * plugins ship with Caelo, so their source is not in the database. Their
 * components render into pages and inherit the pinned family, so a weight
 * they set would be invisible to the default `wght` clamp. This test
 * keeps that gap closed: if a Tier-1 plugin starts setting font weights
 * (or anything the scan cannot read), it fails here, and the fix is to
 * feed that plugin's styles into the usage scan.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scanSiteFontUsage, type ThemeDocument } from "@caelo-cms/shared";

const PLUGINS_DIR = join(import.meta.dir, "..", "..", "..", "packages", "plugins");

function sources(dir: string): { label: string; text: string }[] {
  const out: { label: string; text: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "dist", "__tests__"].includes(entry.name)) continue;
      out.push(...sources(path));
    } else if (/\.(ts|js|svelte|css|html)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
      out.push({ label: path.slice(PLUGINS_DIR.length + 1), text: readFileSync(path, "utf8") });
    }
  }
  return out;
}

describe("Tier-1 plugin sources vs. the font usage scan", () => {
  it("set no font weight or variation axis the database scan would miss", () => {
    const tokens = {} as ThemeDocument;
    const plugins = sources(PLUGINS_DIR);
    expect(plugins.length).toBeGreaterThan(10);
    const withPlugins = scanSiteFontUsage({ tokens, sources: plugins });
    expect(withPlugins.uncertain).toEqual([]);
    expect(withPlugins.variationSettingsAxes).toEqual([]);
    expect(withPlugins.weights).toEqual(scanSiteFontUsage({ tokens, sources: [] }).weights);
  });
});
