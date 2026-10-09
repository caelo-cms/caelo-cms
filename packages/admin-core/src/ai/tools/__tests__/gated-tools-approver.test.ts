// SPDX-License-Identifier: MPL-2.0

/**
 * #589 — `attachGatedExecute` applies a gated tool as the human who clicked
 * Approve, so that human's permission decides. Stub ops + a stub adapter
 * whose "role join" answers per actor: `execute` still does the real
 * lookup, actorScope check and input validation.
 */

import { describe, expect, it } from "bun:test";
import {
  type DatabaseAdapter,
  defineOperation,
  type OperationDefinition,
  OperationRegistry,
} from "@caelo-cms/query-api";
import { type ExecutionContext, ok } from "@caelo-cms/shared";
import { z } from "zod";

import { requiresApproverPermission } from "../../../ops/_approver-permission.js";
import type { FilteredTool } from "../../chat-runner/tool-catalogue.js";
import { attachGatedExecute } from "../gated-tools.js";

const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-0000000000a1",
  actorKind: "ai",
  requestId: "gated-approver-test",
};
const OWNER: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-0000000000c1",
  actorKind: "human",
  requestId: "gated-approver-test-owner",
};
const EDITOR: ExecutionContext = { ...OWNER, actorId: "00000000-0000-0000-0000-0000000000c2" };
const PROPOSAL_ID = "11111111-1111-4111-8111-111111111111";

/** Permissions each stub human holds through their roles. */
const HELD: Record<string, string[]> = {
  [OWNER.actorId]: ["content.read", "content.write", "roles.manage"],
  [EDITOR.actorId]: ["content.read", "content.write"],
};

function harness(declarePermission: boolean) {
  const calls: { op: string; actor: string }[] = [];
  const registry = new OperationRegistry();
  registry.register(
    defineOperation({
      name: "widgets.propose_update",
      actorScope: ["human", "ai", "system"],
      database: "cms_admin",
      input: z.object({ widgetId: z.string() }).strict(),
      output: z.object({ proposalId: z.string(), preview: z.record(z.string(), z.unknown()) }),
      handler: async (ctx) => {
        calls.push({ op: "widgets.propose_update", actor: ctx.actorId });
        return ok({ proposalId: PROPOSAL_ID, preview: {} });
      },
    }),
  );
  const executor = defineOperation({
    name: "widgets.execute_proposal",
    actorScope: ["human", "system"],
    database: "cms_admin",
    input: z.object({ proposalId: z.string().uuid() }).strict(),
    output: z.object({ applied: z.boolean() }),
    handler: async (ctx) => {
      calls.push({ op: "widgets.execute_proposal", actor: ctx.actorId });
      return ok({ applied: true });
    },
  });
  registry.register(
    declarePermission ? requiresApproverPermission(["roles.manage"], executor) : executor,
  );
  const adapter = {
    runOperation: (op: OperationDefinition, ctx: ExecutionContext, input: unknown) =>
      op.handler(ctx, input, {
        execute: async () => (HELD[ctx.actorId] ?? []).map((name) => ({ name })),
      } as never),
  } as unknown as DatabaseAdapter;
  const tool = {
    name: "update_widget",
    description: "update a widget",
    inputSchema: { type: "object" },
    gated: {
      proposeOp: "widgets.propose_update",
      executeOp: "widgets.execute_proposal",
      pendingQueuePath: "/security/widgets/pending",
    },
  } as FilteredTool;
  const run = (approver: ExecutionContext) =>
    attachGatedExecute(tool, registry, adapter, AI, approver).execute?.({
      widgetId: "w1",
    }) as Promise<{ ok: boolean; error?: string; value?: unknown }>;
  return { calls, run };
}

describe("attachGatedExecute — approver permission (#589)", () => {
  it("applies when the approving human holds the executor's permission", async () => {
    const { calls, run } = harness(true);
    const r = await run(OWNER);
    // The model reads the status first: approved and applied, nothing
    // pending (a bare op output read as "still waiting for the click").
    expect(r).toMatchObject({ ok: true, value: { applied: true } });
    expect((r as { status?: string }).status).toContain("APPLIED");
    expect(calls.map((c) => c.op)).toEqual(["widgets.propose_update", "widgets.execute_proposal"]);
  });

  it("refuses an approver without it: nothing applies, the proposal waits in the queue", async () => {
    const { calls, run } = harness(true);
    const r = await run(EDITOR);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("roles.manage");
    expect(r.error).toContain(PROPOSAL_ID);
    expect(r.error).toContain("/security/widgets/pending");
    // Proposed (so an Owner can approve it from the queue), never executed.
    expect(calls.map((c) => c.op)).toEqual(["widgets.propose_update"]);
  });

  it("fails closed when the executor declares no approver permission", async () => {
    const { calls, run } = harness(false);
    const r = await run(OWNER);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("declares no approver permission");
    expect(calls).toEqual([]);
  });
});
