// SPDX-License-Identifier: MPL-2.0

/**
 * #847 — `subscribe` is a public write: it always demands a captcha proof
 * (no "only when a captcha handle happens to exist" branch) and judges
 * the honeypot server-side, so a bot that POSTs directly gets a fake
 * success and nothing is stored or mailed.
 */

import { describe, expect, it } from "bun:test";
import { HONEYPOT_FIELD_NAME } from "@caelo-cms/plugin-component-kit";
import type { PluginContextTier1 } from "@caelo-cms/plugin-sdk";
import plugin from "./index.js";

function harness(proofOk: boolean) {
  const state = { captchaCalls: 0, inserts: 0, mails: 0 };
  const ctx = {
    invocation: { origin: "visitor", actorId: "v" },
    captcha: {
      requireProof: async () => {
        state.captchaCalls += 1;
        return proofOk;
      },
    },
    query: {
      list: async () => [],
      insert: async () => {
        state.inserts += 1;
        return { id: "s1" };
      },
    },
    email: {
      send: async () => {
        state.mails += 1;
      },
    },
  } as unknown as PluginContextTier1;
  return { ctx, state };
}

const subscribe = (ctx: PluginContextTier1, args: unknown) => {
  const op = plugin.operations.subscribe;
  if (!op) throw new Error("subscribe missing");
  return op(ctx, args);
};

describe("newsletter subscribe", () => {
  it("rejects a request whose captcha proof fails, storing nothing", async () => {
    const h = harness(false);
    await expect(subscribe(h.ctx, { email: "a@example.com" })).rejects.toThrow(
      /captcha verification failed/,
    );
    expect(h.state.captchaCalls).toBe(1);
    expect(h.state.inserts).toBe(0);
    expect(h.state.mails).toBe(0);
  });

  it("requires the proof on every legitimate subscribe", async () => {
    const h = harness(true);
    const r = await subscribe(h.ctx, { email: "a@example.com", [HONEYPOT_FIELD_NAME]: "" });
    expect(r).toMatchObject({ id: "s1", awaitingConfirm: true });
    expect(h.state.captchaCalls).toBe(1);
    expect(h.state.inserts).toBe(1);
  });

  it("fakes success for a filled honeypot without storing or mailing", async () => {
    const h = harness(true);
    const r = await subscribe(h.ctx, { email: "bot@example.com", [HONEYPOT_FIELD_NAME]: "x" });
    expect(r).toEqual({ id: "00000000-0000-0000-0000-000000000000", awaitingConfirm: true });
    expect(h.state.inserts).toBe(0);
    expect(h.state.mails).toBe(0);
  });
});
