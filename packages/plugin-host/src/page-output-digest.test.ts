// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1644 (#1647) — what shapes an observer's view of every page: its
 * version, and its settings per module, content block and page type, with
 * or without a global configuration. A changed module setting changes the
 * digest, so the next Stage delivers every page again.
 */

import { describe, expect, it } from "bun:test";
import type { PluginConfigReader } from "@caelo-cms/plugin-sdk";
import type { LoadedPlugin } from "./dispatch.js";
import { observerDigestOf } from "./page-output-host.js";

const entityOnly = {
  definition: {
    version: "1.0.0",
    entityConfig: {
      module: { mode: { type: "enum", options: ["full", "never"], default: "full" } },
    },
  },
} as unknown as LoadedPlugin;

/** A reader whose module m1 has `mode`; it has no global configuration to read. */
const reader = (mode: string): PluginConfigReader => ({
  get: async () => {
    throw new Error("the plugin declares no global configuration");
  },
  entity: async () => ({ mode }),
  entities: async (_kind, ids) => new Map(ids.map((id) => [id, { mode }] as const)),
  configured: async () => ["m1"],
});

describe("the observer digest", () => {
  it("counts module settings of a plugin without a global configuration", async () => {
    const full = await observerDigestOf(entityOnly, reader("full"));
    const never = await observerDigestOf(entityOnly, reader("never"));
    expect(full).not.toBe(never);
    expect(await observerDigestOf(entityOnly, reader("full"))).toBe(full);
  });

  it("a plugin without any configuration is digested by its version alone", async () => {
    const bare = { definition: { version: "2.0.0" } } as unknown as LoadedPlugin;
    expect(await observerDigestOf(bare, null)).toBe(await observerDigestOf(bare, null));
    expect(await observerDigestOf(bare, null)).not.toBe(
      await observerDigestOf({ definition: { version: "2.0.1" } } as unknown as LoadedPlugin, null),
    );
  });
});
