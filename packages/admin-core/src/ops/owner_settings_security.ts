// SPDX-License-Identifier: MPL-2.0

/**
 * owner_settings.{propose_set_plugin_ai_cost_cap,
 * propose_rotate_gateway_cookie_secret} — two more Owner actions behind the
 * owner-settings §11.A gate (CLAUDE.md §11.A, migration 0244).
 *
 *  - A plugin's AI cost cap bounds what one plugin may spend on AI per 24h
 *    (the plugin host refuses its AI calls past it). A raised cap is money
 *    spent before anyone notices; a lowered one silently breaks the plugin's
 *    AI features. Same class as `propose_set_ai_budget`.
 *  - Rotating the gateway cookie secret invalidates every cookie the public
 *    gateway has signed — every visitor is re-identified, signed-in site
 *    visitors sign in again — and the old secret cannot be restored.
 *
 * Both direct ops (`plugins.set_ai_cost_cap`, `gateway.rotate_cookie_secret`)
 * stay human+system; `owner_settings.execute_proposal` applies the queued
 * payload through their handlers, via {@link applyOwnerSecurityProposal}.
 */

import { defineOperation } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { rotateCookieSecretOp } from "./gateway.js";
import {
  errorMessage,
  handlerError,
  type OwnerSettingsKind,
  proposeOutput,
  queueProposal,
  type Tx,
} from "./owner_settings_queue.js";
import { getPluginOp } from "./plugins/registry.js";
import { aggregatePluginAiSpendOp, setPluginAiCostCapOp } from "./security/ai_calls.js";

/** Microcents (1e-8 USD) → "$1.23"; null → "uncapped". */
function usd(microcents: number | null): string {
  return microcents === null ? "uncapped" : `$${(microcents / 100_000_000).toFixed(2)}`;
}

// ─── propose_set_plugin_ai_cost_cap ──────────────────────────────────

export const proposePluginAiCostCapInput = z
  .object({
    pluginSlug: z.string().min(1).max(120).describe("Plugin slug as list_plugins shows it."),
    capMicrocents: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe(
        "Max AI spend per rolling 24h in microcents (1e-8 USD): $5 = 500000000. null removes the cap.",
      ),
  })
  .strict();

/** What the approve applies: the plugin is pinned by id at propose time. */
const queuedPluginAiCostCap = z
  .object({
    pluginId: z.string().uuid(),
    pluginSlug: z.string(),
    capMicrocents: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const proposeSetPluginAiCostCapOp = defineOperation({
  name: "owner_settings.propose_set_plugin_ai_cost_cap",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposePluginAiCostCapInput,
  output: proposeOutput,
  handler: async (ctx, input, tx) => {
    const op = "owner_settings.propose_set_plugin_ai_cost_cap";
    const found = await getPluginOp.handler(ctx, { slug: input.pluginSlug }, tx);
    if (!found.ok) return handlerError(op, "could not read the plugin");
    const plugin = found.value.plugin;
    if (!plugin) {
      return handlerError(
        op,
        `no plugin "${input.pluginSlug}" — list_plugins shows the installed plugins.`,
      );
    }
    const spend = await aggregatePluginAiSpendOp.handler(ctx, { pluginId: plugin.id }, tx);
    if (!spend.ok) return handlerError(op, "could not read the plugin's AI spend");
    const from = spend.value.capMicrocents;
    if (from === input.capMicrocents) {
      return handlerError(op, `${plugin.slug}'s AI cost cap is already ${usd(from)}.`);
    }
    const summary = `${plugin.slug} AI cost cap: ${usd(from)} → ${usd(input.capMicrocents)} per 24h`;
    return queueProposal(
      tx,
      ctx,
      "set_plugin_ai_cost_cap",
      { pluginId: plugin.id, pluginSlug: plugin.slug, capMicrocents: input.capMicrocents },
      {
        plugin: plugin.slug,
        changes: {
          aiCostCap: { from: usd(from), to: usd(input.capMicrocents) },
        },
        last24hSpend: usd(spend.value.last24hMicrocents),
        summary,
      },
      op,
      summary,
    );
  },
});

// ─── propose_rotate_gateway_cookie_secret ────────────────────────────

export const proposeRotateCookieSecretInput = z
  .object({
    reason: z
      .string()
      .min(10)
      .max(500)
      .describe(
        "Why the secret must change (e.g. it leaked in a log or backup). Shown to the Owner on the approval.",
      ),
  })
  .strict();

export const proposeRotateGatewayCookieSecretOp = defineOperation({
  name: "owner_settings.propose_rotate_gateway_cookie_secret",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeRotateCookieSecretInput,
  output: proposeOutput,
  handler: async (ctx, input, tx) => {
    const op = "owner_settings.propose_rotate_gateway_cookie_secret";
    // One rotation waiting is enough: a second would only rotate again.
    const pending = (await tx.execute(sql`
      SELECT id::text AS id FROM owner_settings_pending_actions
      WHERE kind = 'rotate_gateway_cookie_secret' AND status = 'pending' LIMIT 1
    `)) as unknown as { id: string }[];
    if (pending[0]) {
      return handlerError(
        op,
        `a cookie-secret rotation is already waiting for approval (proposal ${pending[0].id}).`,
      );
    }
    const summary = "rotate the public gateway's cookie secret";
    return queueProposal(
      tx,
      ctx,
      "rotate_gateway_cookie_secret",
      { reason: input.reason },
      {
        reason: input.reason,
        effect:
          "Every cookie the gateway has signed stops validating: each visitor gets a new identity on the next request (rate-limit and captcha state restart) and signed-in site visitors sign in again. The old secret cannot be restored.",
        summary,
      },
      op,
      summary,
    );
  },
});

// ─── apply (called by owner_settings.execute_proposal) ───────────────

/** The kinds this module queues; `execute_proposal` routes them here. */
export const OWNER_SECURITY_KINDS: ReadonlySet<OwnerSettingsKind> = new Set([
  "set_plugin_ai_cost_cap",
  "rotate_gateway_cookie_secret",
]);

/**
 * Apply one approved proposal of an {@link OWNER_SECURITY_KINDS} kind inside
 * the approving transaction, through the direct op's own handler. Returns an
 * error message, or null when applied.
 */
export async function applyOwnerSecurityProposal(
  ctx: ExecutionContext,
  tx: Tx,
  kind: OwnerSettingsKind,
  payload: unknown,
): Promise<string | null> {
  if (kind === "set_plugin_ai_cost_cap") {
    const p = queuedPluginAiCostCap.parse(payload);
    const r = await setPluginAiCostCapOp.handler(
      ctx,
      { pluginId: p.pluginId, capMicrocents: p.capMicrocents },
      tx,
    );
    return r.ok ? null : `plugins.set_ai_cost_cap failed: ${errorMessage(r.error)}`;
  }
  if (kind === "rotate_gateway_cookie_secret") {
    const r = await rotateCookieSecretOp.handler(ctx, {}, tx);
    return r.ok ? null : `gateway.rotate_cookie_secret failed: ${errorMessage(r.error)}`;
  }
  return `kind ${kind} is not an owner-security proposal`;
}
