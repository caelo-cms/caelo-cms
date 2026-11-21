// SPDX-License-Identifier: MPL-2.0

/**
 * #847 — `submit` accepts only whole-star scores 1..5. A fractional score
 * used to pass the range check and skew every aggregate.
 */

import { describe, expect, it } from "bun:test";
import { refusePublicCall, runDeclaredPublicOperation } from "@caelo-cms/plugin-host";
import {
  indexCheckedQuery,
  type PluginContextTier1,
  type PublicOperationDef,
  publicOperationOf,
} from "@caelo-cms/plugin-sdk";
import plugin from "./index.js";

/**
 * #1340 — a visitor call as the host makes it: the declared input schema
 * first, then the operation's declaration (core code; no plugin handler).
 */
async function asVisitor(
  plugin: { publicOperations?: ReadonlyArray<PublicOperationDef> },
  name: string,
  ctx: PluginContextTier1,
  args: unknown,
): Promise<unknown> {
  const op = publicOperationOf(plugin.publicOperations, name);
  if (!op) throw new Error(`${name} missing`);
  const checked = refusePublicCall(op, { enforced: false, proofVerified: false }, args);
  if (!checked.ok) throw new Error(`${checked.error.kind}: ${checked.error.message}`);
  return runDeclaredPublicOperation(op, ctx, checked.args);
}

function harness() {
  const state = { inserts: 0 };
  const ctx = {
    invocation: { origin: "visitor", actorId: "v" },
    visitor: { id: null },
    captcha: { requireProof: async () => true },
    query: indexCheckedQuery(plugin, "schema", {
      list: async () => [],
      insert: async () => {
        state.inserts += 1;
        return { id: "r1" };
      },
    }),
  } as unknown as PluginContextTier1;
  return { ctx, state };
}

const submit = (ctx: PluginContextTier1, args: unknown) => asVisitor(plugin, "submit", ctx, args);

describe("ratings submit score", () => {
  for (const score of [4.5, 1.0001, 0, 6, Number.NaN, "5"]) {
    it(`rejects ${String(score)}`, async () => {
      const h = harness();
      await expect(submit(h.ctx, { pageId: "p1", score })).rejects.toThrow(
        /InvalidInput: [\s\S]*score/,
      );
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
