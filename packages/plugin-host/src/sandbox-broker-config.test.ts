// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1644 (#1645) — a sandboxed plugin's configuration calls cross the
 * broker with every entity kind the SDK's config reader takes, so a plugin
 * declaring content-block or page-type settings can read them in a
 * sandboxed operation or a batch job. An unknown kind stays refused.
 */

import { describe, expect, it } from "bun:test";
import { CONFIG_ENTITY_KINDS, type PluginContext } from "@caelo-cms/plugin-sdk";
import { brokerSandboxCall } from "./sandbox-runtime.js";

function ctxReading(seen: unknown[][]): PluginContext {
  return {
    config: {
      get: async () => ({}),
      entity: async (...a: unknown[]) => {
        seen.push(["entity", ...a]);
        return {};
      },
      entities: async (...a: unknown[]) => {
        seen.push(["entities", ...a]);
        return new Map();
      },
      configured: async (...a: unknown[]) => {
        seen.push(["configured", ...a]);
        return [];
      },
    },
  } as unknown as PluginContext;
}

describe("the sandbox broker's config calls", () => {
  it("passes every entity kind the SDK supports", async () => {
    const seen: unknown[][] = [];
    const ctx = ctxReading(seen);
    for (const kind of CONFIG_ENTITY_KINDS) {
      await brokerSandboxCall(ctx, "config.entity", [kind, "00000000-0000-4000-8000-000000000001"]);
      await brokerSandboxCall(ctx, "config.entities", [kind, ["x1"]]);
      await brokerSandboxCall(ctx, "config.configured", [kind]);
    }
    expect(seen).toHaveLength(CONFIG_ENTITY_KINDS.length * 3);
    expect(seen.filter((c) => c[1] === "contentInstance")).toHaveLength(3);
    expect(seen.filter((c) => c[1] === "pageType")).toHaveLength(3);
  });

  it("refuses a kind the SDK does not know", async () => {
    await expect(
      brokerSandboxCall(ctxReading([]), "config.configured", ["user"]),
    ).rejects.toThrow();
  });
});
