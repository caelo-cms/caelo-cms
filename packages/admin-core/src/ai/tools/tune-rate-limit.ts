// SPDX-License-Identifier: MPL-2.0

/**
 * P13 — `tune_rate_limit`. AI proposes a per-(plugin, op) rate-limit
 * change; the row lands at status='pending'; an Owner approves at
 * /settings/gateway/pending. AI cannot apply it directly — execute is
 * human+system only.
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const tuneRateLimitInput = z
  .object({
    pluginSlug: z.string().min(1).max(120),
    operation: z.string().min(1).max(120),
    proposedMax: z.number().int().min(1).max(100_000),
    proposedWindowSec: z.number().int().min(1).max(3600),
  })
  .strict();

export type TuneRateLimitInput = z.infer<typeof tuneRateLimitInput>;

export const tuneRateLimitTool: ToolDefinitionWithHandler<TuneRateLimitInput> = {
  name: "tune_rate_limit",
  description:
    "Propose a per-(plugin, operation) rate-limit override, for abuse on a public plugin endpoint (e.g. forms/submit hammered) or when the default 30/60s is too loose/tight. " +
    "APPROVAL-GATED: only queues the proposal, approved on the chat's proposal card. Do not claim the limit was applied.",
  schema: tuneRateLimitInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pluginSlug", "operation", "proposedMax", "proposedWindowSec"],
    properties: {
      pluginSlug: { type: "string", minLength: 1, maxLength: 120 },
      operation: { type: "string", minLength: 1, maxLength: 120 },
      proposedMax: { type: "integer", minimum: 1, maximum: 100000 },
      proposedWindowSec: { type: "integer", minimum: 1, maximum: 3600 },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "gateway.propose_rate_limit",
      input,
    );
    if (!r.ok) {
      return { ok: false, content: `propose_rate_limit failed: ${describeError(r.error)}` };
    }
    const v = r.value as { proposalId: string };
    return {
      ok: true,
      // v0.5.11 — canonical "Queued proposal <uuid>: <summary>." shape
      // so ProposeCard renders inline Approve / Reject.
      content: `Queued proposal ${v.proposalId}: rate-limit ${input.pluginSlug}.${input.operation} = ${input.proposedMax}/${input.proposedWindowSec}s. Approve it on the proposal card in this chat (queue: /settings/gateway/pending).`,
    };
  },
};
