// SPDX-License-Identifier: MPL-2.0

/**
 * #847 — `submit` accepts only whole-star scores 1..5. A fractional score
 * used to pass the range check and skew every aggregate.
 */

import { describe, expect, it } from "bun:test";
import type { PluginContextTier1 } from "@caelo-cms/plugin-sdk";
import plugin from "./index.js";

function harness() {
  const state = { inserts: 0 };
  const ctx = {
    invocation: { origin: "visitor", actorId: "v" },
    visitor: { id: null },
    captcha: { requireProof: async () => true },
    query: {
      list: async () => [],
      insert: async () => {
        state.inserts += 1;
        return { id: "r1" };
      },
    },
  } as unknown as PluginContextTier1;
  return { ctx, state };
}

const submit = (ctx: PluginContextTier1, args: unknown) => {
  const op = plugin.operations.submit;
  if (!op) throw new Error("submit missing");
  return op(ctx, args);
};

describe("ratings submit score", () => {
  for (const score of [4.5, 1.0001, 0, 6, Number.NaN, "5"]) {
    it(`rejects ${String(score)}`, async () => {
      const h = harness();
      await expect(submit(h.ctx, { pageId: "p1", score })).rejects.toThrow(/score must be 1..5/);
      expect(h.state.inserts).toBe(0);
    });
  }

  it("accepts an integer score", async () => {
    const h = harness();
    const r = await submit(h.ctx, { pageId: "p1", score: 4 });
    expect(r).toMatchObject({ recorded: true });
    expect(h.state.inserts).toBe(1);
  });
});
