// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.31 — generic factory for "propose-then-Owner-approves" AI tools.
 *
 * Every gated domain in CLAUDE.md §11.A follows the same shape:
 *  1. AI calls `<domain>.propose_<action>(input)` — returns a
 *     `{proposalId, preview}` result.
 *  2. Tool tells the AI: "Queued — Owner clicks Approve at
 *     /security/<domain>/pending."
 *
 * Each per-domain tool wrapper used to be ~50 LOC of boilerplate; this
 * factory collapses it to ~10 LOC. The factory enforces:
 *  - Tool description carries the TWO-STEP wording + DO NOT claim
 *    success language (the boundary the model needs to hold).
 *  - Success message renders the proposalId, the pending-queue URL,
 *    and a domain-specific summary line built from the preview jsonb.
 *  - Errors describe the underlying op + the original message.
 */

import { execute } from "@caelo-cms/query-api";
import type { z } from "zod";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export interface MakeProposeToolArgs<I> {
  /** AI tool name surfaced to the model (e.g. `propose_create_user`). */
  readonly toolName: string;
  /** Underlying op name (e.g. `users.propose_create`). */
  readonly opName: string;
  /** Pending-queue path the AI tells the operator to click. */
  readonly pendingQueuePath: string;
  /**
   * Two-line model brief: when to use + the contract. The factory
   * appends the standard TWO-STEP / DO NOT claim wording.
   */
  readonly when: string;
  readonly schema: z.ZodType<I>;
  readonly inputSchema: Record<string, unknown>;
  /** Render a one-line operator-readable summary from the preview. */
  readonly summarize: (input: I, preview: Record<string, unknown>) => string;
}

export function makeProposeTool<I>(args: MakeProposeToolArgs<I>): ToolDefinitionWithHandler<I> {
  const description =
    `${args.when} ` +
    `TWO-STEP: this only QUEUES the proposal; an Owner must click Approve at ${args.pendingQueuePath} to apply. ` +
    `DO NOT claim the change is live. The tool returns proposalId + preview; tell the operator to approve at the queue.`;
  return {
    name: args.toolName,
    description,
    schema: args.schema,
    inputSchema: args.inputSchema,
    handler: async (ctx, input, toolCtx) => {
      const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, args.opName, input);
      if (!r.ok) {
        return { ok: false, content: `${args.opName} failed: ${describeError(r.error)}` };
      }
      const v = r.value as { proposalId: string; preview: Record<string, unknown> };
      const summary = args.summarize(input, v.preview);
      return {
        ok: true,
        content: `Queued proposal ${v.proposalId}: ${summary}. An Owner must click Approve at ${args.pendingQueuePath} to apply.`,
      };
    },
  };
}
