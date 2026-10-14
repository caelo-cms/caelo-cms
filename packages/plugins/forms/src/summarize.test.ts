// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #741 — `summarize` hands its AI work to a Power-MCP agent: a
 * delegated call returns the exact prompt as a work item (no `apply`;
 * the summary is for the agent's operator) and never touches ctx.ai.
 */

import { describe, expect, it } from "bun:test";
import type { AiWorkItem, PluginContextTier1 } from "@caelo-cms/plugin-sdk";
import plugin from "./index.js";

const rows = [
  { id: "1", status: "new", data: { message: "Pricing?" } },
  { id: "2", status: "read", data: { message: "HELLO" } },
];

function harness(opts: {
  delegated?: boolean;
  aiText?: string;
  withAi?: boolean;
  empty?: boolean;
}) {
  const state = { aiCalls: 0, aiPrompt: undefined as unknown };
  const ai =
    opts.withAi === false
      ? undefined
      : {
          complete: async (prompt: unknown) => {
            state.aiCalls += 1;
            state.aiPrompt = prompt;
            if (opts.aiText === undefined) throw new Error("AiDelegated: ctx.ai is not available");
            return { text: opts.aiText, inputTokens: 5, outputTokens: 1 };
          },
        };
  const ctx = {
    invocation: { origin: "chat", actorId: "a", aiDelegated: opts.delegated },
    query: {
      list: async () => {
        return opts.empty ? [] : rows;
      },
    },
    ai,
  } as unknown as PluginContextTier1;
  return { ctx, state };
}

const run = (ctx: PluginContextTier1, args: unknown) => {
  const op = plugin.operations.summarize;
  if (!op) throw new Error("summarize missing");
  return op(ctx, args);
};

const expectedUser =
  'Summarise these 2 submissions:\n- [new] {"message":"Pricing?"}\n- [read] {"message":"HELLO"}';

describe("summarize", () => {
  it("returns a work item without apply on a delegated call, never touching ctx.ai", async () => {
    const { ctx, state } = harness({ delegated: true, withAi: false });
    const r = (await run(ctx, { formSlug: "contact" })) as {
      workItem: AiWorkItem;
      totalConsidered: number;
    };
    expect(state.aiCalls).toBe(0);
    expect(r.totalConsidered).toBe(2);
    expect(r.workItem.kind).toBe("ai_work_item");
    expect(r.workItem.responseFormat).toBe("text");
    expect(r.workItem.apply).toBeUndefined();
    expect(r.workItem.instructions.user).toBe(expectedUser);
    expect(r.workItem.instructions.system).toContain("summarise visitor form submissions");
    expect(r.workItem.task).toContain('"contact"');
  });

  it("does not call a present ctx.ai on a delegated call", async () => {
    const { ctx, state } = harness({ delegated: true });
    await run(ctx, {});
    expect(state.aiCalls).toBe(0);
  });

  it("answers an empty window directly, without a work item", async () => {
    const { ctx } = harness({ delegated: true, empty: true });
    expect(await run(ctx, {})).toEqual({ summary: "No submissions in the requested window." });
  });

  it("summarises with the install's AI on the install-side path, same prompt", async () => {
    const { ctx, state } = harness({ aiText: "2 submissions; pricing." });
    const r = await run(ctx, {});
    expect(r).toEqual({ summary: "2 submissions; pricing.", totalConsidered: 2 });
    expect(state.aiCalls).toBe(1);
    expect(state.aiPrompt).toMatchObject({
      messages: [{ role: "user", content: expectedUser }],
      maxTokens: 400,
    });
  });

  it("requires the ai capability on the install-side path", async () => {
    const { ctx } = harness({ withAi: false });
    await expect(run(ctx, {})).rejects.toThrow(/ai_provider capability/);
  });
});
