// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.31 — generic factory for "propose-then-Owner-approves" AI tools.
 *
 * Every gated domain in CLAUDE.md §11.A follows the same shape:
 *  1. AI calls `<domain>.propose_<action>(input)` — returns a
 *     `{proposalId, preview}` result.
 *  2. Tool tells the AI: "Queued — the operator approves on the chat's
 *     /settings/<domain>/pending."
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
import type { CredentialKind } from "../../ops/credential_handoffs.js";
import { describeError, toolError } from "./_describe-error.js";
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
  /**
   * Provider JSON Schema. Optional: when omitted the tool registry derives
   * it from `schema` (issue #251), which is the preferred path — one source
   * of truth, no drift.
   */
  readonly inputSchema?: Record<string, unknown>;
  /** Render a one-line operator-readable summary from the preview. */
  readonly summarize: (input: I, preview: Record<string, unknown>) => string;
  /**
   * Override the derived `<domain>.execute_proposal`. Needed when a
   * domain has more than one gated action and they cannot share one
   * executor's output shape (plugins: uninstall vs. activate).
   */
  readonly executeOpOverride?: string;
  /** Post-commit step for the gated tool — see FilteredTool.gated. */
  readonly afterApply?: "load-activated-plugin" | "sync-operator-access";
  /**
   * #971 — approving this creates a credential. The executor returns a
   * credential handoff (never the secret) and the description gains the
   * standard "you never see it" contract. See GatedToolSpec.producesCredential.
   */
  readonly producesCredential?: CredentialKind;
}

/**
 * #971 — the contract every credential-producing gated tool states, so the
 * model neither waits for the secret nor offers to repeat it.
 */
export const CREDENTIAL_CONTRACT =
  "CREDENTIALS: the created password / token is never shown to you (not now, not later, not on request); never ask for or offer it. " +
  "After approval, tell the operator where the approver collects it once (the result's `credential` field names the place).";

export function makeProposeTool<I>(args: MakeProposeToolArgs<I>): ToolDefinitionWithHandler<I> {
  // Plan B (SDK approval gate) — every propose op name is `<domain>.propose_*`,
  // so its paired executor is `<domain>.execute_proposal`. The gated tool's
  // execute (built by the chat-runner) chains propose → execute_proposal after
  // the Owner's in-chat Approve, reusing the existing per-domain apply logic.
  const domain = args.opName.split(".")[0] ?? "";
  const executeOp = args.executeOpOverride ?? `${domain}.execute_proposal`;
  const description =
    `${args.when}\n` +
    (args.producesCredential ? `${CREDENTIAL_CONTRACT}\n` : "") +
    "APPROVAL-GATED: pauses for the operator's in-chat Approve/Reject before anything changes; do not claim it is live until approved.";
  return {
    name: args.toolName,
    description,
    schema: args.schema,
    ...(args.inputSchema ? { inputSchema: args.inputSchema } : {}),
    // Marks the tool SDK-executed + gated; the chat-runner attaches the real
    // execute (propose → execute_proposal). approvalMode makes the SDK pause.
    approvalMode: "user-approval",
    gated: {
      proposeOp: args.opName,
      executeOp,
      pendingQueuePath: args.pendingQueuePath,
      ...(args.afterApply ? { afterApply: args.afterApply } : {}),
      ...(args.producesCredential ? { producesCredential: args.producesCredential } : {}),
    },
    // Fallback handler — NOT used on the gated (SDK-executed) path, kept so the
    // registered tool stays a valid ToolDefinitionWithHandler. If ever reached
    // (gate somehow bypassed), it proposes-only, never silently applies.
    handler: async (ctx, input, toolCtx) => {
      const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, args.opName, input);
      if (!r.ok) {
        return toolError(r.error, `${args.opName} failed: ${describeError(r.error)}`);
      }
      const v = r.value as { proposalId: string; preview: Record<string, unknown> };
      return {
        ok: true,
        // Reached on the Power-MCP surface, which has no in-chat Approve
        // card: name the queue where the Owner approves the pending row.
        content: `Queued proposal ${v.proposalId}: ${args.summarize(input, v.preview)}. Not applied yet — the Owner approves it at ${args.pendingQueuePath}.`,
      };
    },
  };
}
