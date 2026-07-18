// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.31 — generic factory for "propose-then-Owner-approves" AI tools.
 *
 * Every gated domain in CLAUDE.md §11.A follows the same shape:
 *  1. AI calls `<domain>.propose_<action>(input)` — returns a
 *     `{proposalId, preview}` result.
 *  2. Tool tells the AI: "Queued — the operator approves on the chat's
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
  // Plan B (SDK approval gate) — every propose op name is `<domain>.propose_*`,
  // so its paired executor is `<domain>.execute_proposal`. The gated tool's
  // execute (built by the chat-runner) chains propose → execute_proposal after
  // the Owner's in-chat Approve, reusing the existing per-domain apply logic.
  const domain = args.opName.split(".")[0] ?? "";
  const executeOp = `${domain}.execute_proposal`;
  const description =
    `${args.when} ` +
    `APPROVAL-GATED: calling this PAUSES for the operator's Approve/Reject right in the chat before anything changes. ` +
    `Do not claim the change is live until it is approved.`;
  return {
    name: args.toolName,
    description,
    schema: args.schema,
    inputSchema: args.inputSchema,
    // Marks the tool SDK-executed + gated; the chat-runner attaches the real
    // execute (propose → execute_proposal). approvalMode makes the SDK pause.
    approvalMode: "user-approval",
    gated: { proposeOp: args.opName, executeOp },
    // Fallback handler — NOT used on the gated (SDK-executed) path, kept so the
    // registered tool stays a valid ToolDefinitionWithHandler. If ever reached
    // (gate somehow bypassed), it proposes-only, never silently applies.
    handler: async (ctx, input, toolCtx) => {
      const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, args.opName, input);
      if (!r.ok) {
        return { ok: false, content: `${args.opName} failed: ${describeError(r.error)}` };
      }
      const v = r.value as { proposalId: string; preview: Record<string, unknown> };
      return {
        ok: true,
        content: `Queued proposal ${v.proposalId}: ${args.summarize(input, v.preview)}.`,
      };
    },
  };
}
