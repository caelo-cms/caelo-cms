// SPDX-License-Identifier: MPL-2.0

/**
 * v0.6.0 W5 — `needsApproval` predicate on ToolDefinitionWithHandler.
 *
 * Verifies:
 *  1. When `needsApproval` returns true, the dispatcher returns a
 *     "Queued proposal …" structured result WITHOUT calling the
 *     handler.
 *  2. When `needsApproval` returns false, the handler runs normally.
 *  3. `buildApprovalPreview` shapes the preview shown to the operator.
 *  4. Async predicates work.
 *  5. Throwing from `needsApproval` lets the action through + logs (no
 *     silent block).
 *
 * This is the foundation: future PRs migrate individual high-blast
 * ops to use this gate instead of building bespoke `*_pending_actions`
 * tables. We don't migrate any existing ops in this PR — those are
 * working, audited, and shipping the same UX.
 */

import { describe, expect, it } from "bun:test";
import type { ExecutionContext } from "@caelo-cms/shared";
import { z } from "zod";
import { type ToolContext, type ToolDefinitionWithHandler, ToolRegistry } from "../dispatch.js";

const ctx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000001",
  actorKind: "ai",
  requestId: "needs-approval-test",
};

const toolCtx = {} as unknown as ToolContext;

function makeGatedTool(opts: {
  name: string;
  needsApproval: (input: { go: boolean }) => boolean | Promise<boolean>;
  buildApprovalPreview?: (input: { go: boolean }) => Record<string, unknown>;
  onHandler?: () => void;
}): ToolDefinitionWithHandler<{ go: boolean }> {
  return {
    name: opts.name,
    description: "test tool",
    schema: z.object({ go: z.boolean() }),
    inputSchema: { type: "object" },
    needsApproval: opts.needsApproval,
    ...(opts.buildApprovalPreview ? { buildApprovalPreview: opts.buildApprovalPreview } : {}),
    handler: async () => {
      opts.onHandler?.();
      return { ok: true, content: "handler ran" };
    },
  };
}

describe("ToolRegistry needsApproval gate (W5)", () => {
  it("returns a Queued proposal result and does NOT run the handler when gated", async () => {
    let handlerRan = false;
    const reg = new ToolRegistry();
    reg.register(
      makeGatedTool({
        name: "gated_tool",
        needsApproval: () => true,
        onHandler: () => {
          handlerRan = true;
        },
      }),
    );
    const result = await reg.dispatch("gated_tool", { go: true }, ctx, toolCtx);
    expect(result.ok).toBe(true);
    // Test toolCtx has no adapter/registry → out-of-chat fallback
    // emits a deliberately NON-canonical string ("[needs-approval,
    // non-persisted]") so ProposeCard's regex skips it. Production
    // path goes through tool_approvals.queue + emits the canonical
    // "Queued proposal <uuid>:" shape that ProposeCard renders.
    expect(result.content).toContain("[needs-approval, non-persisted]");
    expect(result.content).toContain("gated_tool");
    expect(result.content).not.toMatch(/^Queued proposal/);
    expect(handlerRan).toBe(false);
  });

  it("runs the handler normally when the predicate returns false", async () => {
    let handlerRan = false;
    const reg = new ToolRegistry();
    reg.register(
      makeGatedTool({
        name: "ungated_tool",
        needsApproval: () => false,
        onHandler: () => {
          handlerRan = true;
        },
      }),
    );
    const result = await reg.dispatch("ungated_tool", { go: true }, ctx, toolCtx);
    expect(handlerRan).toBe(true);
    expect(result.content).toBe("handler ran");
  });

  it("can decide based on the parsed input", async () => {
    let handlerRan = false;
    const reg = new ToolRegistry();
    reg.register(
      makeGatedTool({
        name: "conditional_tool",
        // Only gate when go=true; allow when go=false.
        needsApproval: (input) => input.go === true,
        onHandler: () => {
          handlerRan = true;
        },
      }),
    );
    const allowed = await reg.dispatch("conditional_tool", { go: false }, ctx, toolCtx);
    expect(allowed.content).toBe("handler ran");
    expect(handlerRan).toBe(true);

    handlerRan = false;
    const gated = await reg.dispatch("conditional_tool", { go: true }, ctx, toolCtx);
    expect(handlerRan).toBe(false);
    expect(gated.content).toContain("[needs-approval, non-persisted]");
  });

  it("invokes buildApprovalPreview and surfaces it in the result content", async () => {
    const reg = new ToolRegistry();
    reg.register(
      makeGatedTool({
        name: "preview_tool",
        needsApproval: () => true,
        buildApprovalPreview: (input) => ({
          affectedPages: 14,
          inputEcho: input,
        }),
      }),
    );
    const result = await reg.dispatch("preview_tool", { go: true }, ctx, toolCtx);
    expect(result.content).toContain('"affectedPages":14');
    expect(result.content).toContain('"go":true');
  });

  it("works with an async predicate", async () => {
    const reg = new ToolRegistry();
    reg.register(
      makeGatedTool({
        name: "async_tool",
        needsApproval: async () => {
          await new Promise((r) => setTimeout(r, 1));
          return true;
        },
      }),
    );
    const result = await reg.dispatch("async_tool", { go: true }, ctx, toolCtx);
    expect(result.content).toContain("[needs-approval, non-persisted]");
  });

  it("lets the action through (no silent block) when the predicate throws", async () => {
    let handlerRan = false;
    const reg = new ToolRegistry();
    reg.register(
      makeGatedTool({
        name: "buggy_tool",
        needsApproval: () => {
          throw new Error("predicate threw");
        },
        onHandler: () => {
          handlerRan = true;
        },
      }),
    );
    const result = await reg.dispatch("buggy_tool", { go: true }, ctx, toolCtx);
    expect(handlerRan).toBe(true);
    expect(result.content).toBe("handler ran");
  });
});
