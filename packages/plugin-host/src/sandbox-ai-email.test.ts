// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 — `ctx.ai` and `ctx.email` of a runtime-installed plugin through
 * the real Deno sandbox. The child gets a handle only when the host
 * attached one; the broker parses the wire arguments and hands them to the
 * host handle, which holds every rule (capabilities-brokered-calls.test.ts
 * and the integration tests cover those). Adversarial: a plugin cannot add
 * arguments that would name another plugin, a model or a sender, and there
 * is no way to reach a free-form `send`.
 */

import { describe, expect, it } from "bun:test";
import type { PluginContext, PluginManifest } from "@caelo-cms/plugin-sdk";
import { sandboxMessage } from "./sandbox-protocol.js";
import { brokerSandboxCall, runSandbox } from "./sandbox-runtime.js";

const ID = "11111111-1111-4111-8111-111111111111";
const manifest: PluginManifest = {
  slug: "ai-mail-probe",
  version: "1.0.0",
  tier: 2,
  schema: {},
  operations: ["run"],
  hasStaticRender: false,
  hasBuildData: false,
  hasDeferrals: false,
  hasContentVariants: false,
  hasLinkResolve: false,
  hasShareImages: false,
  hasListResolve: false,
};
const base: PluginContext = {
  query: {
    insert: async () => ({ id: ID }),
    list: async () => [],
    update: async () => {},
    updateMany: async () => {},
    delete: async () => {},
    compareAndSwap: async () => true,
  },
  api: { list: async () => [], get: async () => null },
  theme: { tokens: {} },
  visitor: { id: null, publicUserId: null, ipHash: "", sessionToken: null },
  captcha: { requireProof: async () => true },
  invocation: { origin: "worker", actorId: ID },
};

/** What the host handles received, by method. */
function hostHandles() {
  const received: Array<{ method: string; args: unknown[] }> = [];
  const record =
    (method: string, answer: unknown) =>
    async (...args: unknown[]) => {
      received.push({ method, args });
      return answer;
    };
  return {
    received,
    ai: {
      complete: record("ai.complete", { text: "ok", inputTokens: 1, outputTokens: 1 }),
      generateObject: record("ai.generateObject", {
        object: { a: 1 },
        inputTokens: 1,
        outputTokens: 1,
      }),
    },
    email: {
      queue: record("email.queue", undefined),
      unsubscribeLink: record("email.unsubscribeLink", "https://www.example.test/x"),
      send: record("email.send", { messageId: "must-not-happen" }),
    },
  };
}

function run(body: string, extra: Record<string, unknown> = {}) {
  return runSandbox({
    source: `export default {slug:"ai-mail-probe",version:"1.0.0",tier:2,operations:{run:async(ctx)=>{${body}}}};`,
    manifest,
    operation: "run",
    args: {},
    context: { ...base, ...extra } as PluginContext,
    authorize: async () => {},
  });
}

describe("#1729 — ctx.ai and ctx.email in the sandbox", () => {
  it("are absent without the host's handles, so no call reaches the host", async () => {
    expect(await run("return [typeof ctx.ai, typeof ctx.email];")).toEqual([
      "undefined",
      "undefined",
    ]);
  });

  it("carry the plugin's options to the host handle unchanged", async () => {
    const host = hostHandles();
    const value = await run(
      `const t = await ctx.ai.complete({ system: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 10 });
       const o = await ctx.ai.generateObject({ system: "s", messages: [], jsonSchema: { type: "object" } });
       await ctx.email.queue({ template: "confirm", to: "a@example.com", token: "abcdefghijklmnop" });
       const link = await ctx.email.unsubscribeLink({ recipientId: "${ID}" });
       return { t: t.text, o: o.object, link };`,
      { ai: host.ai, email: host.email },
    );
    expect(value).toEqual({ t: "ok", o: { a: 1 }, link: "https://www.example.test/x" });
    expect(host.received.map((r) => r.method)).toEqual([
      "ai.complete",
      "ai.generateObject",
      "email.queue",
      "email.unsubscribeLink",
    ]);
    expect(host.received[0]?.args).toEqual([
      { system: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 10 },
    ]);
  });

  it("has no send, and the broker has no method for one", async () => {
    const host = hostHandles();
    expect(
      await run(
        `try { await ctx.email.send({ to: "a@example.com", subject: "s", html: "x" }); return "sent"; }
         catch (e) { return typeof ctx.email.send; }`,
        { email: host.email },
      ),
    ).toBe("undefined");
    // A forged wire line naming it is refused before any broker runs...
    expect(
      sandboxMessage.safeParse({ kind: "call", id: 0, method: "email.send", args: [{}] }).success,
    ).toBe(false);
    // ...and the broker itself knows no such method.
    await expect(
      brokerSandboxCall({ ...base, email: host.email } as PluginContext, "email.send", [
        { to: "a@example.com", subject: "s", html: "x" },
      ]),
    ).rejects.toThrow("SandboxMethodDenied");
    expect(host.received).toEqual([]);
  });

  it("refuses arguments that would name another plugin, a model or a sender", async () => {
    const host = hostHandles();
    const refused = await run(
      `const out = [];
       const tries = [
         () => ctx.ai.complete({ system: "s", messages: [] }, { pluginId: "${ID}" }),
         () => ctx.ai.complete("not options"),
         () => ctx.email.queue({ template: "confirm", to: "a@example.com", from: "ceo@example.com" }),
         () => ctx.email.queue({ template: "confirm", to: "a@example.com" }, { plugin: "newsletter" }),
         () => ctx.email.unsubscribeLink({ recipientId: "${ID}", plugin: "newsletter" }),
         () => ctx.email.unsubscribeLink({ recipientId: "not-a-uuid" }),
       ];
       for (const attempt of tries) {
         try { await attempt(); out.push("passed"); } catch { out.push("refused"); }
       }
       return out;`,
      { ai: host.ai, email: host.email },
    );
    expect(refused).toEqual(Array(6).fill("refused"));
    expect(host.received).toEqual([]);
  });
});
