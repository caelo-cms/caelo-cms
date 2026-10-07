// SPDX-License-Identifier: MPL-2.0

/**
 * §11.A gated tools for the Owner settings the agent previously could not
 * touch at all: AI budgets, AI pricing, gateway settings. Each wraps an
 * `owner_settings.propose_*` op (owner_settings_pending.ts); after the
 * operator's in-chat Approve the chat-runner chains
 * `owner_settings.execute_proposal`, which applies the existing
 * `ai_budgets.set` / `ai_pricing.set` / `gateway.set_settings` handler.
 * Over the Power-MCP the same tools queue the proposal and the Owner
 * approves it at /security/owner-settings/pending.
 *
 * The three read tools below are their companions: the AI reads the
 * current caps / rates / gateway knobs before proposing a change, instead
 * of proposing blind or asking the operator what is configured.
 *
 * Telemetry consent deliberately has no tool — see the `Why human-only`
 * note on `telemetry.set`.
 */

import { z } from "zod";
import type { getGatewaySettingsOp } from "../../ops/gateway.js";
import {
  proposeAiBudgetInput,
  proposeAiPricingInput,
  proposeGatewaySettingsInput,
} from "../../ops/owner_settings_pending.js";
import type { aiBudgetsStatusOp } from "../../ops/security/ai_budgets.js";
import type { listAiPricingOp } from "../../ops/security/ai_pricing.js";
import { makeProposeTool } from "./_make-propose-tool.js";
import { makeReadTool } from "./_make-read-tool.js";

const PENDING_QUEUE = "/security/owner-settings/pending";

export const proposeSetAiBudgetTool = makeProposeTool({
  toolName: "propose_set_ai_budget",
  opName: "owner_settings.propose_set_ai_budget",
  pendingQueuePath: PENDING_QUEUE,
  when:
    "Propose AI spend caps: per chat session, per day site-wide (day-global), or per day per person (day-per-actor), each separately for text and image generation. " +
    "Use when the operator names a budget, or a budget gate blocked/warned and the operator wants it raised or lowered. Several cells go in ONE call (`budgets` array). " +
    "Caps are microcents (1e-8 USD): $10 = 1000000000; null = unlimited. Never propose an amount the operator did not name — the click confirms their number, not yours. " +
    "Read the current caps first with get_ai_budgets. Not for a single migration run's ceiling — that is set_migration_budget.",
  schema: proposeAiBudgetInput,
  summarize: (_input, preview) => `AI budget: ${String(preview.summary ?? "change caps")}`,
});

export const proposeSetAiPricingTool = makeProposeTool({
  toolName: "propose_set_ai_pricing",
  opName: "owner_settings.propose_set_ai_pricing",
  pendingQueuePath: PENDING_QUEUE,
  when:
    "Propose AI pricing rows (what each provider/model call is billed at — drives cost tracking and every budget gate). " +
    "Use when a tool reports 'no ai_pricing row' / UNPRICED spend for a model, or the provider changed its prices. Several rows go in ONE call (`rows` array). " +
    "Rates are microcents PER 1K TOKENS: $3 per million tokens = 300000. Take rates from the provider's published price list or the operator — never guess; if you do not know the price, ask. " +
    "For dated prices (intro pricing, an announced change) send one row per window with validFrom/validTo and distinct effectiveFrom. Read the rows in force first with list_ai_pricing.",
  schema: proposeAiPricingInput,
  summarize: (_input, preview) => `AI pricing: ${String(preview.summary ?? "set rates")}`,
});

export const proposeSetGatewaySettingsTool = makeProposeTool({
  toolName: "propose_set_gateway_settings",
  opName: "owner_settings.propose_set_gateway_settings",
  pendingQueuePath: PENDING_QUEUE,
  when:
    "Propose a change to the public API gateway: captcha provider + proof-of-work difficulty on visitor writes (forms, comments, signups), the max request body size, and auto-redeploy (publish production automatically after publishable writes, its debounce and which ops count). " +
    "Read the current values with get_gateway_settings, then send ONLY the settings that change; everything else keeps its current value. Fails loudly if nothing would change. " +
    "Not for per-plugin rate limits — that is tune_rate_limit.",
  schema: proposeGatewaySettingsInput,
  summarize: (_input, preview) => `gateway: ${String(preview.summary ?? "settings change")}`,
});

// ─── read companions ─────────────────────────────────────────────────

const noInput = z.object({}).strict();
type OpValue<O extends { output: z.ZodType }> = z.infer<O["output"]>;

/** Microcents (1e-8 USD) → "$1.23"; null → "unlimited". */
function usd(microcents: number | null): string {
  return microcents === null ? "unlimited" : `$${(microcents / 100_000_000).toFixed(2)}`;
}

export const getAiBudgetsTool = makeReadTool({
  name: "get_ai_budgets",
  description:
    "Read the AI spend caps and today's spend against them (per session / per day site-wide / per day per person, text and image separately). " +
    "Use before propose_set_ai_budget, or when a budget warning/block needs explaining. Amounts are shown in USD and raw microcents.",
  opName: "ai_budgets.status",
  input: noInput,
  format: (value) => {
    const rows = (value as OpValue<typeof aiBudgetsStatusOp>).rows;
    if (rows.length === 0) return "No AI budgets configured — every scope is unlimited.";
    return rows
      .map(
        (r) =>
          `${r.scope}/${r.operationType}: cap ${usd(r.capMicrocents)} (${r.capMicrocents ?? "null"}µ¢), ` +
          `spent ${r.spentMicrocents === null ? "n/a (per session)" : usd(r.spentMicrocents)}, status ${r.status}`,
      )
      .join("\n");
  },
});

export const listAiPricingTool = makeReadTool({
  name: "list_ai_pricing",
  description:
    "List the AI pricing rows currently in force (provider, model, text/image, rates). Rates are microcents PER 1K TOKENS ($3/MTok = 300000). " +
    "Use before propose_set_ai_pricing, or when a cost report says a model is unpriced.",
  opName: "ai_pricing.list",
  input: noInput,
  format: (value) => {
    const rows = (value as OpValue<typeof listAiPricingOp>).rows;
    if (rows.length === 0) return "No AI pricing rows — every AI call is recorded at cost 0.";
    return rows
      .map(
        (r) =>
          `${r.provider}/${r.model} (${r.operationType}): input=${r.inputMicrocents} output=${r.outputMicrocents ?? "null"} ` +
          `cacheRead=${r.cachedMicrocents ?? "null"} cacheWrite=${r.cacheCreationMicrocents ?? "null"} ` +
          `effectiveFrom=${r.effectiveFrom} window=${r.validFrom ?? "open"}..${r.validTo ?? "open"}`,
      )
      .join("\n");
  },
});

export const getGatewaySettingsTool = makeReadTool({
  name: "get_gateway_settings",
  description:
    "Read the public API gateway settings: captcha provider + proof-of-work difficulty, max request body, auto-redeploy (on/off, debounce, triggering ops). " +
    "Use before propose_set_gateway_settings.",
  opName: "gateway.get_settings",
  input: noInput,
  format: (value) => {
    const { cookieSecretSet: _secret, ...s } = (value as OpValue<typeof getGatewaySettingsOp>)
      .settings;
    return JSON.stringify(s);
  },
});
