// SPDX-License-Identifier: MPL-2.0

/**
 * #1361 (Codex review of #1557) — an approval card in a chat turn whose
 * tool builds (an approved Publish live, rollback, publish anyway) runs its
 * executor as a carried build (#1574), like the pending pages' Approve. The
 * turn waits for it as before, but the build lives in the request its
 * carrier holds open: a tab closed mid-build stops the turn, not the build,
 * and on request-billed CPU a build left without any request would stall.
 * Every other executor still runs inside the turn's request.
 */

import { describe, expect, it, mock } from "bun:test";
import {
  type DatabaseAdapter,
  defineOperation,
  type OperationDefinition,
  OperationRegistry,
} from "@caelo-cms/query-api";
import { type ExecutionContext, ok } from "@caelo-cms/shared";
import { z } from "zod";
import * as realCarry from "../../../build-carrier/carry.js";
import { requiresApproverPermission } from "../../../ops/_approver-permission.js";
import type { FilteredTool } from "../../chat-runner/tool-catalogue.js";

const carried: { op: string; input: unknown; actor: string }[] = [];
const NO_CARRIER = "This build ran without its carrier, inside this request.";
mock.module("../../../build-carrier/carry.js", () => ({
  ...realCarry,
  executeBuild: async (
    _deps: unknown,
    ctx: ExecutionContext,
    op: string,
    input: Record<string, unknown>,
  ) => {
    carried.push({ op, input, actor: ctx.actorId });
    return { ok: true, value: { runId: "run-1" }, warning: NO_CARRIER };
  },
}));
const { attachGatedExecute } = await import("../gated-tools.js");

const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-0000000000a1",
  actorKind: "ai",
  requestId: "gated-build-test",
};
const OWNER: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-0000000000c1",
  actorKind: "human",
  requestId: "gated-build-test-owner",
};
const PROPOSAL_ID = "11111111-1111-4111-8111-111111111111";

/** A propose op and its executor, recording the executor's own calls. */
function harness(domain: string) {
  const direct: string[] = [];
  const registry = new OperationRegistry();
  registry.register(
    defineOperation({
      name: `${domain}.propose_it`,
      readScope: "request",
      actorScope: ["human", "ai", "system"],
      database: "cms_admin",
      input: z.object({}).strict(),
      output: z.object({ proposalId: z.string(), preview: z.record(z.string(), z.unknown()) }),
      handler: async () => ok({ proposalId: PROPOSAL_ID, preview: {} }),
    }),
  );
  registry.register(
    requiresApproverPermission(
      ["deploy.trigger"],
      defineOperation({
        name: `${domain}.execute_proposal`,
        readScope: "request",
        actorScope: ["human", "system"],
        database: "cms_admin",
        input: z.object({ proposalId: z.string().uuid() }).strict(),
        output: z.object({ applied: z.boolean() }),
        handler: async () => {
          direct.push(`${domain}.execute_proposal`);
          return ok({ applied: true });
        },
      }),
    ),
  );
  const adapter = {
    runOperation: (op: OperationDefinition, ctx: ExecutionContext, input: unknown) =>
      op.handler(ctx, input, {
        // The approver holds the executor's permission.
        execute: async () => [{ name: "deploy.trigger" }],
      } as never),
  } as unknown as DatabaseAdapter;
  const tool = {
    name: `${domain}_tool`,
    description: "a gated tool",
    inputSchema: { type: "object" },
    gated: {
      proposeOp: `${domain}.propose_it`,
      executeOp: `${domain}.execute_proposal`,
      pendingQueuePath: `/settings/${domain}/pending`,
    },
  } as FilteredTool;
  const run = () =>
    attachGatedExecute(tool, registry, adapter, AI, OWNER).execute?.({}) as Promise<{
      ok: boolean;
      error?: string;
      value?: Record<string, unknown>;
    }>;
  return { direct, run };
}

describe("an approved card whose tool builds (#1361)", () => {
  it("runs the build as a carried build, as the approver, and passes on a no-carrier warning", async () => {
    for (const domain of ["deploy", "quality_audits"]) {
      carried.length = 0;
      const { direct, run } = harness(domain);
      const r = await run();
      expect(r.ok).toBe(true);
      expect(carried).toEqual([
        {
          op: `${domain}.execute_proposal`,
          input: { proposalId: PROPOSAL_ID },
          actor: OWNER.actorId,
        },
      ]);
      // Not run in the turn's own request.
      expect(direct).toEqual([]);
      expect(r.value).toMatchObject({ runId: "run-1", warning: NO_CARRIER });
    }
  });

  it("runs every other executor in the turn's request, as before", async () => {
    carried.length = 0;
    const { direct, run } = harness("widgets");
    const r = await run();
    expect(r).toMatchObject({ ok: true, value: { applied: true } });
    expect(direct).toEqual(["widgets.execute_proposal"]);
    expect(carried).toEqual([]);
  });
});
