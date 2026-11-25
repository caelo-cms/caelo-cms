// SPDX-License-Identifier: MPL-2.0

/**
 * #1654 — the AI's tools for the visitor AI (a plugin's `ai-chat`
 * operation answering visitors): read its settings, key state and spend,
 * and propose new settings through the owner-settings gate (§11.A). The
 * key is never the AI's: the approval card asks the Owner for it.
 */

import { execute } from "@caelo-cms/query-api";
import { untrustedToolResult } from "@caelo-cms/shared";
import { z } from "zod";
import type { getVisitorAiOp, visitorAiSpendOp } from "../../ops/visitor_ai.js";
import { proposeVisitorAiInput } from "../../ops/visitor_ai.js";
import { describeError, toolError } from "./_describe-error.js";
import { makeProposeTool } from "./_make-propose-tool.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

type OpValue<O extends { output: z.ZodType }> = z.infer<O["output"]>;

export const proposeSetVisitorAiTool = makeProposeTool({
  toolName: "propose_set_visitor_ai",
  opName: "owner_settings.propose_set_visitor_ai",
  pendingQueuePath: "/settings/owner-settings/pending",
  when:
    "Propose the visitor AI's settings: on/off, provider, model, budgets (24 hours, 30 days, per conversation, staging per 24 hours), conversations at once, and ceilings that lower a plugin's limits (null = the plugin's).\n" +
    "USE FOR: the operator wants visitors' questions answered with AI (a site assistant plugin needs it before it can be activated), or a budget or limit changed. Read `get_visitor_ai` first.\n" +
    "CORE RULES: send only what changes. Omit `model` with a new provider: its fastest model is chosen. Never propose a budget the operator did not name (when they name none, propose the stored ones). NEVER include an API key: the card asks the operator for it and you never see it.",
  schema: proposeVisitorAiInput,
  summarize: (_input, preview) => String(preview.summary ?? "visitor AI settings change"),
});

export const getVisitorAiTool: ToolDefinitionWithHandler<Record<string, never>> = {
  name: "get_visitor_ai",
  description:
    "Read the visitor AI (the AI that answers visitors through a plugin such as a site assistant): settings, whether a key is stored for live and staging (provider and date, never the key), why it cannot run (`blocked`), and what visitors spent in the last 24 hours and 30 days. Use before `propose_set_visitor_ai` and when the operator asks what the assistant costs.",
  schema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  inputSchema: { type: "object", additionalProperties: false, properties: {} },
  handler: async (ctx, _input, toolCtx) => {
    const got = await execute(toolCtx.registry, toolCtx.adapter, ctx, "visitor_ai.get", {});
    if (!got.ok) return toolError(got.error, `visitor_ai.get failed: ${describeError(got.error)}`);
    const v = got.value as OpValue<typeof getVisitorAiOp>;
    const spent = await execute(toolCtx.registry, toolCtx.adapter, ctx, "visitor_ai.spend", {});
    // The gateway writes the ledger, and cms_public is attacker-writable (#635).
    const spend = spent.ok
      ? untrustedToolResult(spent.value as OpValue<typeof visitorAiSpendOp>)
      : `spend unavailable: ${describeError(spent.error)}`;
    return {
      ok: true,
      content: `${JSON.stringify({
        settings: v.settings,
        keys: v.keys,
        blocked: v.blocked,
        providerLimitHint: v.providerLimitHint,
      })}\nspend: ${spend}`,
      value: v,
    };
  },
};
