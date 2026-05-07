// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.37 — `cancel_proposal` AI tool. Lets the AI withdraw a
 * proposal it queued in error.
 *
 * Use cases:
 *  - "Wait, I shouldn't have proposed that delete — cancel it."
 *  - User says "actually let's not do that, cancel the proposal".
 *  - AI realizes mid-conversation that a proposal won't make sense.
 *
 * Restricted to the calling actor's own pending proposals via the
 * underlying op's WHERE clause. AI cannot cancel proposals queued by
 * other actors (the operator's own work, another AI session).
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const inputSchema = z
  .object({
    proposalId: z.string().uuid(),
    reason: z.string().min(1).max(500).optional(),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export const cancelProposalTool: ToolDefinitionWithHandler<Input> = {
  name: "cancel_proposal",
  description:
    "Cancel a pending proposal that you (the AI) queued earlier in this conversation but no longer want applied. " +
    "Use when you realized the proposal was wrong, or the user said 'never mind'. " +
    "ONLY works on proposals you queued — you cannot cancel proposals from the operator's own work or other AI sessions. " +
    "If the proposal was already approved/rejected, the tool returns an error explaining that. " +
    "Provide an optional `reason` (≤500 chars) for the audit log. " +
    "After cancelling, tell the user the proposal is withdrawn — it will no longer appear in /security/pending.",
  schema: inputSchema,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["proposalId"],
    properties: {
      proposalId: { type: "string", format: "uuid" },
      reason: { type: "string", minLength: 1, maxLength: 500 },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "pending_proposals.cancel",
      input,
    );
    if (!r.ok) {
      return { ok: false, content: `cancel_proposal failed: ${describeError(r.error)}` };
    }
    const v = r.value as { cancelled: boolean; domain: string | null };
    return {
      ok: true,
      content: `Proposal ${input.proposalId.slice(0, 8)}… cancelled (domain=${v.domain ?? "?"}). Tell the user the proposal is withdrawn.`,
    };
  },
};
