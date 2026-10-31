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
import { describeError, toolError } from "./_describe-error.js";
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
    "Withdraw a pending proposal YOU queued in this conversation (it was wrong, or the user said 'never mind'). " +
    "Refused for others' proposals and already approved/rejected ones. Then tell the user it is withdrawn.",
  schema: inputSchema,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["proposalId"],
    properties: {
      proposalId: { type: "string", format: "uuid" },
      reason: { type: "string", minLength: 1, maxLength: 500, description: "For the audit log." },
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
      return toolError(r.error, `cancel_proposal failed: ${describeError(r.error)}`);
    }
    const v = r.value as { cancelled: boolean; domain: string | null };
    return {
      ok: true,
      content: `Proposal ${input.proposalId} cancelled (domain=${v.domain ?? "?"}). Tell the user the proposal is withdrawn.`,
    };
  },
};
