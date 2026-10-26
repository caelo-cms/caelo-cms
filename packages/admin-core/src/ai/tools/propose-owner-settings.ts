// SPDX-License-Identifier: MPL-2.0

/**
 * §11.A gated tools for the Owner settings the agent previously could not
 * touch at all: AI budgets, AI pricing, gateway settings, the translation
 * model (#593), a plugin's AI cost cap and the gateway cookie secret. Each wraps an `owner_settings.propose_*` op
 * (owner_settings_pending.ts); after the operator's in-chat Approve the
 * chat-runner chains `owner_settings.execute_proposal`, which applies the
 * existing `ai_budgets.set` / `ai_pricing.set` / `gateway.set_settings` /
 * `ai_providers.set_translation_model` handler.
 * Over the Power-MCP the same tools queue the proposal and the Owner
 * approves it at /settings/owner-settings/pending.
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
  proposeTranslationModelInput,
} from "../../ops/owner_settings_pending.js";
import {
  proposePluginAiCostCapInput,
  proposeRotateCookieSecretInput,
} from "../../ops/owner_settings_security.js";
import type { aiBudgetsStatusOp } from "../../ops/security/ai_budgets.js";
import type { listAiPricingOp } from "../../ops/security/ai_pricing.js";
import { makeProposeTool } from "./_make-propose-tool.js";
import { makeReadTool } from "./_make-read-tool.js";

const PENDING_QUEUE = "/settings/owner-settings/pending";

export const proposeSetAiBudgetTool = makeProposeTool({
  toolName: "propose_set_ai_budget",
  opName: "owner_settings.propose_set_ai_budget",
  pendingQueuePath: PENDING_QUEUE,
  when:
    "Propose AI spend caps per chat session, per day site-wide or per day per person; text and image separately.\n" +
    "USE FOR: operator names a budget, or a budget gate blocked/warned and they want it changed. Read current caps first (`get_ai_budgets`).\n" +
    "DO NOT USE FOR: one migration run's ceiling -> `set_migration_budget`.\n" +
    "CORE RULES: several cells -> ONE call. Never propose an amount the operator did not name — the click confirms their number, not yours.",
  schema: proposeAiBudgetInput,
  summarize: (_input, preview) => `AI budget: ${String(preview.summary ?? "change caps")}`,
});

export const proposeSetAiPricingTool = makeProposeTool({
  toolName: "propose_set_ai_pricing",
  opName: "owner_settings.propose_set_ai_pricing",
  pendingQueuePath: PENDING_QUEUE,
  when:
    "Propose AI pricing rows (billing rate per provider/model; drives cost tracking + every budget gate).\n" +
    "USE FOR: a tool reports 'no ai_pricing row' / UNPRICED spend, or the provider changed prices. Read rows in force first (`list_ai_pricing`).\n" +
    "CORE RULES: several rows -> ONE call. Rates from the provider's published price list or the operator — never guess; unknown -> ask. Dated prices (intro, announced change) -> one row per window with validFrom/validTo + distinct effectiveFrom.",
  schema: proposeAiPricingInput,
  summarize: (_input, preview) => `AI pricing: ${String(preview.summary ?? "set rates")}`,
});

export const proposeSetGatewaySettingsTool = makeProposeTool({
  toolName: "propose_set_gateway_settings",
  opName: "owner_settings.propose_set_gateway_settings",
  pendingQueuePath: PENDING_QUEUE,
  when:
    "Propose public API gateway settings: captcha / proof-of-work on visitor writes (forms, comments, signups), max body size, auto-redeploy.\n" +
    "DO NOT USE FOR: per-plugin rate limits -> `tune_rate_limit`.\n" +
    "CORE RULES: read current values (`get_gateway_settings`), send ONLY what changes (rest kept); fails if nothing would change.",
  schema: proposeGatewaySettingsInput,
  summarize: (_input, preview) => `gateway: ${String(preview.summary ?? "settings change")}`,
});

export const proposeSetTranslationModelTool = makeProposeTool({
  toolName: "propose_set_translation_model",
  opName: "owner_settings.propose_set_translation_model",
  pendingQueuePath: PENDING_QUEUE,
  when:
    "Propose the model page translations (international-site plugin) run on, within the active AI provider; chat model unaffected.\n" +
    "USE FOR: cheaper/faster/better translations, or back to the chat model. Read chat model, current translation model + catalogue first (`list_ai_providers`). Preview shows both models' per-MTok rates.",
  schema: proposeTranslationModelInput,
  summarize: (_input, preview) => String(preview.summary ?? "translation model change"),
});

export const proposeSetPluginAiCostCapTool = makeProposeTool({
  toolName: "propose_set_plugin_ai_cost_cap",
  opName: "owner_settings.propose_set_plugin_ai_cost_cap",
  pendingQueuePath: PENDING_QUEUE,
  when:
    "Propose ONE plugin's AI spend cap per rolling 24h (beyond it its AI calls are refused).\n" +
    "USE FOR: operator names a cap, or `get_plugin` (current cap + spend; read first) shows it at/near its cap. Never propose an amount the operator did not name.\n" +
    "DO NOT USE FOR: site-wide caps -> `propose_set_ai_budget`.",
  schema: proposePluginAiCostCapInput,
  summarize: (_input, preview) => String(preview.summary ?? "plugin AI cost cap change"),
});

export const proposeRotateGatewayCookieSecretTool = makeProposeTool({
  toolName: "propose_rotate_gateway_cookie_secret",
  opName: "owner_settings.propose_rotate_gateway_cookie_secret",
  pendingQueuePath: PENDING_QUEUE,
  when: "Propose rotating the secret the public gateway signs visitor cookies with. ONLY when the operator asks or it may have leaked (logs, backup, former contractor): irreversible — every visitor re-identified, rate-limit + captcha state restart, signed-in visitors sign in again. You never see the secret.",
  schema: proposeRotateCookieSecretInput,
  summarize: () => "rotate the gateway cookie secret",
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
    "Read AI spend caps + today's spend (per session / day site-wide / day per person; text + image), in USD and microcents. Use before `propose_set_ai_budget` or to explain a budget warning/block.",
  opName: "ai_budgets.status",
  input: noInput,
  // day-per-actor spend is recorded against the human operator, not the AI
  // actor — read it as the operator so the row describes THEIR budget.
  runAsOperator: true,
  format: (value) => {
    const rows = (value as OpValue<typeof aiBudgetsStatusOp>).rows;
    if (rows.length === 0) return "No AI budgets configured — every scope is unlimited.";
    return rows
      .map(
        (r) =>
          `${r.scope}/${r.operationType}: cap ${usd(r.capMicrocents)} (${r.capMicrocents ?? "null"}µ¢), ` +
          `warnAtPct ${r.warnAtPct}, spent ${r.spentMicrocents === null ? "n/a (per session)" : usd(r.spentMicrocents)}, status ${r.status}`,
      )
      .join("\n");
  },
});

export const listAiPricingTool = makeReadTool({
  name: "list_ai_pricing",
  description:
    "List AI pricing rows in force (text rates = microcents/1K tokens; image input = microcents/image). Use before `propose_set_ai_pricing` or when a model is reported unpriced.",
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
    "Read public API gateway settings (captcha, proof-of-work, max body, auto-redeploy). Use before `propose_set_gateway_settings`.",
  opName: "gateway.get_settings",
  input: noInput,
  format: (value) => {
    const { cookieSecretSet: _secret, ...s } = (value as OpValue<typeof getGatewaySettingsOp>)
      .settings;
    return JSON.stringify(s);
  },
});
