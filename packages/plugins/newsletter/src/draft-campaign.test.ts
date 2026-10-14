// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #741 — `draft_campaign` hands its AI work to a Power-MCP agent:
 * a delegated call returns a work item and writes nothing, the agent's
 * `bodyHtml` is saved without ctx.ai, and the install-side path still
 * drafts with the install's AI.
 */

import { describe, expect, it } from "bun:test";
import type { AiWorkItem, PluginContextTier1 } from "@caelo-cms/plugin-sdk";
import plugin from "./index.js";

const base = { slug: "spring", subject: "Spring news", brief: "Announce the spring sale." };

function harness(opts: { delegated?: boolean; aiText?: string; withAi?: boolean }) {
  const state = { aiCalls: 0, inserts: [] as Array<Record<string, unknown>> };
  const ai =
    opts.withAi === false
      ? undefined
      : {
          complete: async () => {
            state.aiCalls += 1;
            if (opts.aiText === undefined) throw new Error("AiDelegated: ctx.ai is not available");
            return { text: opts.aiText, inputTokens: 42, outputTokens: 1 };
          },
        };
  const ctx = {
    invocation: { origin: "chat", actorId: "a", aiDelegated: opts.delegated },
    query: {
      insert: async (_t: string, row: Record<string, unknown>) => {
        state.inserts.push(row);
        return { id: "camp-1" };
      },
    },
    ai,
  } as unknown as PluginContextTier1;
  return { ctx, state };
}

const run = (ctx: PluginContextTier1, args: unknown) => {
  const op = plugin.operations.draft_campaign;
  if (!op) throw new Error("draft_campaign missing");
  return op(ctx, args);
};

describe("draft_campaign", () => {
  it("returns a work item on a delegated call, writing nothing and never touching ctx.ai", async () => {
    const { ctx, state } = harness({ delegated: true });
    const r = (await run(ctx, base)) as { workItem: AiWorkItem };
    expect(state.aiCalls).toBe(0);
    expect(state.inserts).toHaveLength(0);
    expect(r.workItem.kind).toBe("ai_work_item");
    expect(r.workItem.responseFormat).toBe("text");
    expect(r.workItem.instructions.user).toBe(base.brief);
    expect(r.workItem.instructions.system).toContain("newsletter campaign in clean HTML");
    expect(r.workItem.apply).toEqual({
      tool: "draft_newsletter_campaign",
      args: base,
      resultArg: "bodyHtml",
    });
  });

  it("works delegated even without the ai capability handle", async () => {
    const { ctx } = harness({ delegated: true, withAi: false });
    const r = (await run(ctx, base)) as { workItem: AiWorkItem };
    expect(r.workItem.kind).toBe("ai_work_item");
  });

  it("saves the agent's bodyHtml as a draft without ctx.ai", async () => {
    const { ctx, state } = harness({ delegated: true });
    const r = await run(ctx, { ...base, bodyHtml: "<h1>Spring</h1>" });
    expect(state.aiCalls).toBe(0);
    expect(r).toEqual({ id: "camp-1", costInputTokens: 0 });
    expect(state.inserts).toEqual([
      { slug: "spring", subject: "Spring news", body_html: "<h1>Spring</h1>", status: "draft" },
    ]);
  });

  it("validates bodyHtml", async () => {
    const { ctx, state } = harness({ delegated: true });
    await expect(run(ctx, { ...base, bodyHtml: "   " })).rejects.toThrow();
    await expect(run(ctx, { ...base, bodyHtml: "x".repeat(100_001) })).rejects.toThrow();
    await expect(run(ctx, { ...base, bodyHtml: 7 })).rejects.toThrow();
    expect(state.inserts).toHaveLength(0);
  });

  it("drafts with the install's AI on the install-side path", async () => {
    const { ctx, state } = harness({ aiText: "<p>Sale</p>" });
    const r = await run(ctx, base);
    expect(state.aiCalls).toBe(1);
    expect(r).toEqual({ id: "camp-1", costInputTokens: 42 });
    expect(state.inserts[0]).toMatchObject({ body_html: "<p>Sale</p>", status: "draft" });
  });

  it("requires the ai capability on the install-side path", async () => {
    const { ctx } = harness({ withAi: false });
    await expect(run(ctx, base)).rejects.toThrow(/ai_provider capability/);
  });
});
