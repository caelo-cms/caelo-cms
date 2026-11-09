// SPDX-License-Identifier: MPL-2.0

/**
 * #847 — `submit` judges the honeypot server-side under the kit's field
 * name: a bot that POSTs directly gets the same answer as a real visitor
 * and nothing reaches the moderation inbox.
 */

import { describe, expect, it } from "bun:test";
import { HONEYPOT_FIELD_NAME } from "@caelo-cms/plugin-component-kit";
import { indexCheckedQuery, type PluginContextTier1 } from "@caelo-cms/plugin-sdk";
import plugin from "./index.js";

function harness() {
  const state = { inserts: 0, captchaCalls: 0 };
  const ctx = {
    invocation: { origin: "visitor", actorId: "v" },
    captcha: {
      requireProof: async () => {
        state.captchaCalls += 1;
        return true;
      },
    },
    query: indexCheckedQuery(plugin, "schema", {
      list: async () => [],
      insert: async () => {
        state.inserts += 1;
        return { id: "c1" };
      },
    }),
  } as unknown as PluginContextTier1;
  return { ctx, state };
}

const submit = (ctx: PluginContextTier1, args: unknown) => {
  const op = plugin.operations.submit;
  if (!op) throw new Error("submit missing");
  return op(ctx, args);
};

const COMMENT = { pageId: "p1", authorName: "Ann", content: "Nice post" };

describe("comments submit honeypot", () => {
  it("fakes success for a filled honeypot without inserting", async () => {
    const h = harness();
    const r = await submit(h.ctx, { ...COMMENT, [HONEYPOT_FIELD_NAME]: "bot was here" });
    expect(r).toEqual({ commentId: "00000000-0000-0000-0000-000000000000", status: "pending" });
    expect(h.state.inserts).toBe(0);
  });

  it("accepts an empty honeypot and stores the comment pending", async () => {
    const h = harness();
    const r = await submit(h.ctx, { ...COMMENT, [HONEYPOT_FIELD_NAME]: "" });
    expect(r).toEqual({ commentId: "c1", status: "pending" });
    expect(h.state.inserts).toBe(1);
    // #1332 — the captcha is the host's: dispatch refuses a visitor call
    // without a proof bound to comments.submit before this handler runs.
    expect(h.state.captchaCalls).toBe(0);
  });
});
