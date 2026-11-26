// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 — every link resolver declares what its answer is computed from
 * (`linkResolveReads`), shipped or runtime-installed: core keeps the answer
 * per render scope and asks again only after a change to those tables
 * (docs/dev/external-plugin-brokers.md §6.4). The validator refuses a
 * resolver without the declaration, and a declaration naming tables or
 * columns the plugin does not have, since core would then wait for changes
 * that never come and serve the answer stale.
 */

import { describe, expect, it } from "bun:test";
import { manifestFromDefinition, type PluginDefinition } from "@caelo-cms/plugin-sdk";
import { validateManifest } from "./index.js";

function resolver(extra: Record<string, unknown>) {
  return {
    slug: "reads-check",
    version: "0.0.1",
    tier: 2,
    schema: {},
    adminSchema: { variants: { page_id: "uuid", variant: "text", group_id: "text" } },
    operations: ["resolve"],
    requestedCapabilities: ["link_resolve", "cms_admin_schema"],
    hasLinkResolve: true,
    ...extra,
  };
}

function readsFailures(manifest: unknown): string[] {
  return validateManifest(manifest, { allowExternalCapabilities: true })
    .failures.filter((f) => f.kind === "link-resolve-reads")
    .map((f) => f.hint);
}

describe("linkResolveReads (#1729)", () => {
  it("accepts a declaration of the plugin's own tables and columns", () => {
    expect(
      readsFailures(
        resolver({
          linkResolveReads: {
            tables: ["variants"],
            columns: ["page_id", "group_id"],
            pageColumns: { variants: "page_id" },
          },
        }),
      ),
    ).toEqual([]);
    // An answer from the page ids alone reads no table.
    expect(readsFailures(resolver({ linkResolveReads: { tables: [] } }))).toEqual([]);
  });

  it("refuses a resolver that declares nothing, with an example of the field", () => {
    const [hint, ...rest] = readsFailures(resolver({}));
    expect(rest).toEqual([]);
    expect(hint).toContain("does not declare `linkResolveReads`");
    expect(hint).toContain('tables: ["page_variants"]');
  });

  it("refuses tables, columns and page columns the plugin does not have", () => {
    const hints = readsFailures(
      resolver({
        linkResolveReads: {
          tables: ["variants", "pages"],
          columns: ["page_id", "title"],
          pageColumns: { variants: "page", pages: "id" },
        },
      }),
    );
    expect(hints).toHaveLength(4);
    expect(hints[0]).toContain('"pages" is not one of the plugin\'s adminSchema tables (variants)');
    expect(hints[1]).toContain('"title" is not a column');
    expect(hints[2]).toContain('"variants.page"');
    expect(hints[3]).toContain('"pages.id"');
  });

  it("refuses a declaration without a resolver", () => {
    const [hint] = readsFailures(
      resolver({ hasLinkResolve: false, linkResolveReads: { tables: ["variants"] } }),
    );
    expect(hint).toContain("no link resolver");
  });

  it("binds shipped plugins too: a definition's declaration reaches its manifest", () => {
    const def: PluginDefinition = {
      slug: "reads-shipped",
      version: "0.0.1",
      tier: 1,
      schema: {},
      adminSchema: { variants: { page_id: "uuid" } },
      requestedCapabilities: ["link_resolve", "cms_admin_schema"],
      linkResolveOperation: "resolve",
      operations: { resolve: async () => ({ pages: {} }) },
    };
    expect(readsFailures(manifestFromDefinition(def))).toHaveLength(1);
    const declared = manifestFromDefinition({
      ...def,
      linkResolveReads: { tables: ["variants"], pageColumns: { variants: "page_id" } },
    });
    expect(declared.linkResolveReads).toEqual({
      tables: ["variants"],
      pageColumns: { variants: "page_id" },
    });
    expect(readsFailures(declared)).toEqual([]);
  });
});
