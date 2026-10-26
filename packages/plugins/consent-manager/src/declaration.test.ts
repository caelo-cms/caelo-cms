// SPDX-License-Identifier: MPL-2.0

/**
 * The banner offers only real choices (#1129) and the cookie declaration
 * is built from the tag registry (#1133).
 */

import { describe, expect, it } from "bun:test";
import type { PluginAdminQuery } from "@caelo-cms/plugin-sdk";
import type { CategoryRow } from "./categories.js";
import { usedCategoryKeys, vendorEntries } from "./declaration.js";
import { resolveTagColumns, type TagRow } from "./tags.js";

const CATEGORIES: CategoryRow[] = ["necessary", "functional", "analytics", "marketing"].map(
  (key, position) => ({
    id: key,
    key,
    display_name: key[0]?.toUpperCase() + key.slice(1),
    description: "",
    required: key === "necessary",
    position,
  }),
);

/** Answers `list` by equality on the filter's columns, like the host does. */
function fakeQuery(tables: Record<string, Array<Record<string, unknown>>>): PluginAdminQuery {
  return {
    list: async (table: string, filter: Record<string, unknown> = {}) => {
      const rows = (tables[table] ?? []).filter((r) =>
        Object.entries(filter).every(([k, v]) => k === "limit" || r[k] === v),
      );
      return rows.slice(0, Number(filter.limit ?? 100)) as never;
    },
  } as unknown as PluginAdminQuery;
}

function tag(
  name: string,
  fields: Parameters<typeof resolveTagColumns>[1],
  enabled = true,
): TagRow {
  return {
    id: name,
    name,
    enabled,
    ...resolveTagColumns("add_tag", fields, new Set(CATEGORIES.map((c) => c.key))),
  };
}

describe("usedCategoryKeys (#1129)", () => {
  it("counts enabled tags, withheld embeds and other plugins' purposes, nothing else", async () => {
    const ga = tag("GA4", { vendor: "google-analytics", config: { measurementId: "G-ABC123" } });
    const off = tag("Pixel", { vendor: "meta-pixel", config: { pixelId: "1234567" } }, false);
    const q = fakeQuery({ tags: [ga, off] as unknown as Array<Record<string, unknown>> });
    expect([...(await usedCategoryKeys(q, CATEGORIES, [], new Set()))].sort()).toEqual([
      "analytics",
    ]);
    const purposes = [
      { pluginSlug: "comments", key: "visitor", category: "functional", purpose: "x", cookies: [] },
    ];
    expect(
      [
        ...(await usedCategoryKeys(fakeQuery({}), CATEGORIES, purposes, new Set(["marketing"]))),
      ].sort(),
    ).toEqual(["functional", "marketing"]);
  });
});

describe("vendorEntries (#1133)", () => {
  it("groups the declaration by category and carries the vendor data and cookies", () => {
    const entries = vendorEntries({
      categories: CATEGORIES,
      tags: [
        tag("Leadinfo", { vendor: "leadinfo", config: { accountId: "LI-123" } }),
        tag("GA4", { vendor: "google-analytics", config: { measurementId: "G-ABC123" } }),
      ],
      purposes: [],
      settings: {
        id: "s",
        policy_version: 3,
        retention_days: 365,
        placeholder_module_slug: "p",
        declaration_updated_at: new Date("2026-10-20T10:00:00Z"),
      },
    });
    expect(entries.map((e) => e.values.category)).toEqual(["necessary", "analytics", "marketing"]);
    expect(entries.map((e) => e.values.category_first)).toEqual([true, true, true]);
    const ga = entries.find((e) => e.id === "tag:GA4")?.values;
    expect(ga?.vendor).toBe("Google Ireland Limited");
    expect(ga?.third_country).toBe("USA");
    expect(ga?.privacy_policy).toEqual({ href: "https://policies.google.com/privacy" });
    expect(String(ga?.cookies)).toContain("_ga_* (2 years)");
    expect(ga?.updated).toBe("2026-10-20");
    // The site's own consent cookie is always declared.
    expect(entries[0]?.values.cookies).toContain("caelo_consent");
  });
});
