// SPDX-License-Identifier: MPL-2.0

/**
 * #847 — `subscribe` is a public write: it always demands a captcha proof
 * (#1340: the host refuses the call without one, from the declaration) and
 * judges the honeypot server-side, so a bot that POSTs directly gets a
 * fake success and nothing is stored or mailed. The work is core's
 * double opt-in block, run from the declaration.
 */

import { describe, expect, it } from "bun:test";
import { HONEYPOT_FIELD_NAME } from "@caelo-cms/plugin-component-kit";
import { refusePublicCall, runDeclaredPublicOperation } from "@caelo-cms/plugin-host";
import {
  indexCheckedQuery,
  type PluginContextTier1,
  publicOperationOf,
} from "@caelo-cms/plugin-sdk";
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
    query: indexCheckedQuery(plugin, "schema", {
      list: async () => [],
      insert: async () => {
        state.inserts += 1;
        return { id: "s1" };
      },
    }),
    email: {
      queue: async () => {
        state.mails += 1;
      },
    },
  } as unknown as PluginContextTier1;
  return { ctx, state };
}

function declared() {
  const op = publicOperationOf(plugin.publicOperations, "subscribe");
  if (!op) throw new Error("subscribe missing");
  return op;
}

const subscribe = (ctx: PluginContextTier1, args: unknown) =>
  runDeclaredPublicOperation(declared(), ctx, args);

describe("newsletter subscribe", () => {
  it("is refused by the host without a captcha proof, before anything runs", () => {
    const r = refusePublicCall(
      declared(),
      { enforced: true, proofVerified: false },
      { email: "a@example.com" },
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.error.kind).toBe("CaptchaRequired");
  });

  it("stores and mails on a legitimate subscribe", async () => {
    const h = harness(true);
    const r = await subscribe(h.ctx, { email: "a@example.com", [HONEYPOT_FIELD_NAME]: "" });
    expect(r).toEqual({ awaitingConfirm: true });
    expect(h.state.inserts).toBe(1);
    // #1337 — the double opt-in mail is queued, not sent from the gateway.
    expect(h.state.mails).toBe(1);
  });

  it("fakes success for a filled honeypot without storing or mailing", async () => {
    const h = harness(true);
    const r = await subscribe(h.ctx, { email: "bot@example.com", [HONEYPOT_FIELD_NAME]: "x" });
    expect(r).toEqual({ awaitingConfirm: true });
    expect(h.state.inserts).toBe(0);
    expect(h.state.mails).toBe(0);
  });
});

/**
 * P6 (#1336, M5) — subscribing tells nobody whether an address is already
 * on the list: a new, an unconfirmed and a confirmed address get the same
 * answer, with no subscriber id.
 */
describe("newsletter subscribe answers alike for every address", () => {
  function withRow(row: Record<string, unknown> | null) {
    const ctx = {
      invocation: { origin: "visitor", actorId: "v" },
      captcha: { requireProof: async () => true },
      query: indexCheckedQuery(plugin, "schema", {
        list: async () => (row ? [row] : []),
        insert: async () => ({ id: "33333333-3333-4333-8333-333333333333" }),
        update: async () => {},
      }),
      email: { queue: async () => {} },
    } as unknown as PluginContextTier1;
    return subscribe(ctx, { email: "known@example.com" });
  }

  it("is identical for unknown, unconfirmed and confirmed addresses and carries no id", async () => {
    const unknown = await withRow(null);
    const unconfirmed = await withRow({
      id: "11111111-1111-4111-8111-111111111111",
      confirmed_at: null,
      confirm_token: "tok-unconfirmed-0000",
    });
    const confirmed = await withRow({
      id: "22222222-2222-4222-8222-222222222222",
      confirmed_at: "2026-11-01T00:00:00.000Z",
      confirm_token: "tok-confirmed-00000",
    });
    expect(JSON.stringify(unconfirmed)).toBe(JSON.stringify(unknown));
    expect(JSON.stringify(confirmed)).toBe(JSON.stringify(unknown));
    expect(JSON.stringify(unknown)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });
});
