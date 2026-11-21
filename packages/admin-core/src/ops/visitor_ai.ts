// SPDX-License-Identifier: MPL-2.0

/**
 * The visitor AI's settings (epic #1644, R4, issue #1654): provider, model,
 * budgets and ceilings of the AI that answers visitors in the public
 * gateway (a plugin's `ai-chat` operation), migration 0740.
 *
 * They are money and abuse knobs, so `visitor_ai.set` is human+system (the
 * Owner's Settings → Visitor AI) and the AI proposes through the
 * owner-settings §11.A gate (`owner_settings.propose_set_visitor_ai` →
 * `owner_settings.execute_proposal`, which applies the queued payload here).
 *
 * The key is never here. The Owner pastes it on the approval card or in the
 * settings; the admin stores it in its own secret with add-version rights
 * only (visitor-ai/key-store.ts) and records here only which provider each
 * environment's key is for (`visitor_ai.record_key`). The settings reach
 * the gateways with the projection's `settings` section (0740 triggers):
 * a budget the Owner lowers binds at once, like a gateway setting.
 *
 * What visitors spent is read from the gateway's ledger in cms_public
 * (`visitor_ai.spend`), attacker-writable by #635: validated row by row and
 * shown as untrusted data.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { type ExecutionContext, err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { type CatalogProvider, catalogSlots } from "../ai/model-catalog.js";
import { recordAudit } from "../audit.js";
import { parseUntrustedRows, untrustedOperation } from "../untrusted/public-data.js";
import {
  errorMessage,
  handlerError,
  proposeOutput,
  queueProposal,
  type Tx,
} from "./owner_settings_queue.js";

/** The providers a visitor-AI key can be for (the gateway's model factory knows these). */
export const VISITOR_AI_PROVIDERS = ["anthropic", "openai", "google"] as const;
export type VisitorAiProvider = (typeof VISITOR_AI_PROVIDERS)[number];

const MICROCENTS_PER_USD = 100_000_000;

const usd = (max: number) => z.number().min(0).max(max);

/** The settings as the ops read and write them; amounts in USD (bounds = migration 0740). */
export const visitorAiSettingsShape = z
  .object({
    enabled: z.boolean().describe("Whether visitors' conversations run at all."),
    provider: z.enum(VISITOR_AI_PROVIDERS),
    model: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/)
      .describe("The model id; the provider's fastest class unless there is a reason."),
    dailyBudgetUsd: usd(100_000).describe("Most the live site spends in any 24 hours."),
    monthlyBudgetUsd: usd(1_000_000).describe("Most the live site spends in any 30 days."),
    conversationBudgetUsd: usd(100).describe("Most one conversation spends."),
    stagingDailyBudgetUsd: usd(10_000).describe("Staging's own budget per 24 hours."),
    maxConcurrent: z.number().int().min(1).max(500).describe("Conversations answered at once."),
    maxTurns: z.number().int().min(1).max(20).nullable().describe("null: the plugin's limit."),
    maxQuestionChars: z.number().int().min(20).max(2000).nullable(),
    maxAnswerTokens: z.number().int().min(64).max(2000).nullable(),
  })
  .strict();
export type VisitorAiSettings = z.infer<typeof visitorAiSettingsShape>;

/** Where a stored key is used. */
export type VisitorAiEnvironment = "live" | "staging";

/** What is recorded about each environment's key (never the key). */
export interface VisitorAiKeyState {
  readonly provider: VisitorAiProvider | null;
  readonly setAt: string | null;
}

const toUsd = (microcents: string | number) => Number(microcents) / MICROCENTS_PER_USD;
const toMicrocents = (dollars: number) => Math.round(dollars * MICROCENTS_PER_USD);

/**
 * The stored settings and key state. The row is seeded by migration 0740; a
 * missing one is a broken install, reported loudly (CLAUDE.md §2).
 */
export async function readVisitorAi(
  tx: Tx,
): Promise<{ settings: VisitorAiSettings; keys: Record<VisitorAiEnvironment, VisitorAiKeyState> }> {
  const rows = (await tx.execute(sql`
    SELECT enabled, provider, model, daily_budget_microcents::text AS daily,
           monthly_budget_microcents::text AS monthly,
           conversation_budget_microcents::text AS conversation,
           staging_daily_budget_microcents::text AS staging_daily, max_concurrent,
           max_turns, max_question_chars, max_answer_tokens,
           live_key_provider, live_key_set_at::text AS live_key_set_at,
           staging_key_provider, staging_key_set_at::text AS staging_key_set_at
    FROM visitor_ai_settings WHERE id = 1
  `)) as unknown as {
    enabled: boolean;
    provider: VisitorAiProvider;
    model: string;
    daily: string;
    monthly: string;
    conversation: string;
    staging_daily: string;
    max_concurrent: number;
    max_turns: number | null;
    max_question_chars: number | null;
    max_answer_tokens: number | null;
    live_key_provider: VisitorAiProvider | null;
    live_key_set_at: string | null;
    staging_key_provider: VisitorAiProvider | null;
    staging_key_set_at: string | null;
  }[];
  const r = rows[0];
  if (!r) {
    throw new Error(
      "visitor_ai_settings row missing — migration 0740 seeds it; run the database migrations",
    );
  }
  return {
    settings: {
      enabled: r.enabled,
      provider: r.provider,
      model: r.model,
      dailyBudgetUsd: toUsd(r.daily),
      monthlyBudgetUsd: toUsd(r.monthly),
      conversationBudgetUsd: toUsd(r.conversation),
      stagingDailyBudgetUsd: toUsd(r.staging_daily),
      maxConcurrent: r.max_concurrent,
      maxTurns: r.max_turns,
      maxQuestionChars: r.max_question_chars,
      maxAnswerTokens: r.max_answer_tokens,
    },
    keys: {
      live: { provider: r.live_key_provider, setAt: r.live_key_set_at },
      staging: { provider: r.staging_key_provider, setAt: r.staging_key_set_at },
    },
  };
}

/** The provider's fastest model in the curated catalog, or null when it lists none. */
export function fastestModel(provider: VisitorAiProvider): string | null {
  return catalogSlots(provider as CatalogProvider).find((s) => s.role === "fast")?.id ?? null;
}

/** What the Owner is asked to do at the provider, on every surface that shows the key. */
export const PROVIDER_HARD_LIMIT_HINT =
  "Set a monthly spending limit for this key at the provider too (Anthropic: Console → Limits; OpenAI: Settings → Limits; Google: a billing budget on the project). Caelo's budgets bind what Caelo spends; the provider's limit also binds a stolen key.";

const keyStateShape = z.object({
  provider: z.enum(VISITOR_AI_PROVIDERS).nullable(),
  setAt: z.string().nullable(),
});

export const getVisitorAiOp = defineOperation({
  name: "visitor_ai.get",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({
    settings: visitorAiSettingsShape,
    keys: z.object({ live: keyStateShape, staging: keyStateShape }),
    /** Why visitors' conversations cannot run now, or null when they can. */
    blocked: z.string().nullable(),
    providerLimitHint: z.string(),
  }),
  handler: async (_ctx, _input, tx) => {
    const v = await readVisitorAi(tx);
    return ok({
      ...v,
      blocked: visitorAiBlocked(v.settings, v.keys.live),
      providerLimitHint: PROVIDER_HARD_LIMIT_HINT,
    });
  },
});

/**
 * Why the live site's visitors cannot be answered with these settings, or
 * null. The one test activation (`requires: ["visitor-ai"]`) and the
 * settings page apply.
 */
export function visitorAiBlocked(
  settings: VisitorAiSettings,
  liveKey: VisitorAiKeyState,
): string | null {
  if (!settings.enabled) return "the visitor AI is switched off";
  if (liveKey.provider === null) return "no visitor-AI key is stored for the live site";
  if (liveKey.provider !== settings.provider)
    return `the stored key is for ${liveKey.provider}, the settings name ${settings.provider}`;
  if (settings.dailyBudgetUsd <= 0 || settings.monthlyBudgetUsd <= 0)
    return "the daily or 30-day budget is zero";
  if (settings.conversationBudgetUsd <= 0) return "the per-conversation budget is zero";
  return null;
}

export const setVisitorAiOp = defineOperation({
  name: "visitor_ai.set",
  readScope: "request",
  // Why human-only: a raised budget spends the visitor-AI key's money before
  // anyone notices, and switching it on opens a paid endpoint to the public
  // (CLAUDE.md §11.A); the AI proposes with owner_settings.propose_set_visitor_ai.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: visitorAiSettingsShape,
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    if (input.monthlyBudgetUsd < input.dailyBudgetUsd) {
      return err({
        kind: "HandlerError",
        operation: "visitor_ai.set",
        message: `the 30-day budget ($${input.monthlyBudgetUsd}) is below the daily budget ($${input.dailyBudgetUsd}); raise it or lower the daily one`,
      });
    }
    const updated = (await tx.execute(sql`
      UPDATE visitor_ai_settings SET
        enabled = ${input.enabled},
        provider = ${input.provider},
        model = ${input.model},
        daily_budget_microcents = ${toMicrocents(input.dailyBudgetUsd)},
        monthly_budget_microcents = ${toMicrocents(input.monthlyBudgetUsd)},
        conversation_budget_microcents = ${toMicrocents(input.conversationBudgetUsd)},
        staging_daily_budget_microcents = ${toMicrocents(input.stagingDailyBudgetUsd)},
        max_concurrent = ${input.maxConcurrent},
        max_turns = ${input.maxTurns},
        max_question_chars = ${input.maxQuestionChars},
        max_answer_tokens = ${input.maxAnswerTokens},
        updated_at = now(),
        updated_by = ${ctx.actorId}::uuid
      WHERE id = 1
      RETURNING id
    `)) as unknown as unknown[];
    if (updated.length === 0) {
      return err({
        kind: "HandlerError",
        operation: "visitor_ai.set",
        message: "visitor_ai_settings row missing — run the database migrations (0740 seeds it)",
      });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "visitor_ai.set",
      input,
      succeeded: true,
      resultSummary: `${input.enabled ? "on" : "off"}, ${input.provider}/${input.model}, $${input.dailyBudgetUsd}/24h, $${input.monthlyBudgetUsd}/30d, $${input.conversationBudgetUsd}/conversation, staging $${input.stagingDailyBudgetUsd}/24h`,
    });
    return ok({});
  },
});

/** A proposal: only the named fields change, merged onto the row at approve time. */
export const proposeVisitorAiInput = visitorAiSettingsShape
  .extend({
    // Omitted with a new provider: the provider's fastest catalog model.
    model: visitorAiSettingsShape.shape.model.optional(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "name at least one setting to change" });
export type ProposeVisitorAiInput = z.infer<typeof proposeVisitorAiInput>;

/** The settings a proposal would leave, or why it cannot. */
export function mergedVisitorAi(
  current: VisitorAiSettings,
  patch: ProposeVisitorAiInput,
): { ok: true; merged: VisitorAiSettings } | { ok: false; message: string } {
  const provider = patch.provider ?? current.provider;
  let model = patch.model;
  if (model === undefined) {
    if (provider === current.provider) model = current.model;
    else {
      const fast = fastestModel(provider);
      if (fast === null)
        return {
          ok: false,
          message: `the curated catalog has no fast model for ${provider}: name the model (its smallest current text model) in \`model\``,
        };
      model = fast;
    }
  }
  const merged = visitorAiSettingsShape.safeParse({ ...current, ...patch, provider, model });
  if (!merged.success) return { ok: false, message: merged.error.issues[0]?.message ?? "invalid" };
  if (merged.data.monthlyBudgetUsd < merged.data.dailyBudgetUsd)
    return { ok: false, message: "the 30-day budget must be at least the daily budget" };
  return { ok: true, merged: merged.data };
}

export const proposeSetVisitorAiOp = defineOperation({
  name: "owner_settings.propose_set_visitor_ai",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeVisitorAiInput,
  output: proposeOutput,
  handler: async (ctx, input, tx) => {
    const op = "owner_settings.propose_set_visitor_ai";
    const { settings, keys } = await readVisitorAi(tx);
    const m = mergedVisitorAi(settings, input);
    if (!m.ok) return handlerError(op, m.message);
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const key of Object.keys(m.merged) as (keyof VisitorAiSettings)[]) {
      if (m.merged[key] !== settings[key])
        changes[key] = { from: settings[key], to: m.merged[key] };
    }
    if (Object.keys(changes).length === 0) {
      return handlerError(op, "the visitor AI already has these settings — nothing to propose.");
    }
    // The key is the Owner's to paste, never the AI's: the card asks for it
    // when the live site has none for this provider.
    const keyNeeded = m.merged.enabled && keys.live.provider !== m.merged.provider;
    const summary = `visitor AI: ${Object.entries(changes)
      .map(([k, c]) => `${k} ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`)
      .join(", ")}${keyNeeded ? ` — paste the ${m.merged.provider} key on this card` : ""}`;
    return queueProposal(
      tx,
      ctx,
      "set_visitor_ai",
      input,
      {
        changes,
        summary,
        keyNeeded,
        provider: m.merged.provider,
        providerLimitHint: PROVIDER_HARD_LIMIT_HINT,
      },
      op,
      summary,
    );
  },
});

/**
 * Apply an approved `set_visitor_ai` proposal inside the approving
 * transaction: the patch merged onto the settings as they are now, through
 * `visitor_ai.set`. Switching visitors' AI on needs a live key for the
 * provider, which the approver pastes on the card before the approval
 * applies. Returns an error message, or null when applied.
 */
export async function applyVisitorAiProposal(
  ctx: ExecutionContext,
  tx: Tx,
  payload: unknown,
): Promise<string | null> {
  const patch = proposeVisitorAiInput.parse(payload);
  const { settings, keys } = await readVisitorAi(tx);
  const m = mergedVisitorAi(settings, patch);
  if (!m.ok) return m.message;
  if (m.merged.enabled && keys.live.provider !== m.merged.provider) {
    return `no ${m.merged.provider} key is stored for the live site: paste it on the approval card (or under Settings → Visitor AI) and approve again`;
  }
  const r = await setVisitorAiOp.handler(ctx, m.merged, tx);
  return r.ok ? null : `visitor_ai.set failed: ${errorMessage(r.error)}`;
}

export const recordVisitorAiKeyOp = defineOperation({
  name: "visitor_ai.record_key",
  readScope: "request",
  // Why human-only: it follows the Owner's own paste of the key into the
  // secret store (visitor-ai/key-actions.ts), which the AI never sees and
  // never triggers; recording a key nobody stored would make activation pass.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      environment: z.enum(["live", "staging"]),
      /** null: the key was removed. */
      provider: z.enum(VISITOR_AI_PROVIDERS).nullable(),
    })
    .strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    const set = input.provider === null ? sql`NULL` : sql`now()`;
    await tx.execute(
      input.environment === "live"
        ? sql`UPDATE visitor_ai_settings SET live_key_provider = ${input.provider},
                live_key_set_at = ${set}, updated_at = now(), updated_by = ${ctx.actorId}::uuid
              WHERE id = 1`
        : sql`UPDATE visitor_ai_settings SET staging_key_provider = ${input.provider},
                staging_key_set_at = ${set}, updated_at = now(), updated_by = ${ctx.actorId}::uuid
              WHERE id = 1`,
    );
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "visitor_ai.record_key",
      input,
      succeeded: true,
      resultSummary:
        input.provider === null
          ? `${input.environment} visitor-AI key removed`
          : `${input.environment} visitor-AI key stored for ${input.provider}`,
    });
    return ok({});
  },
});

const spendRow = z.object({
  plugin_id: z.string().uuid(),
  operation: untrustedOperation,
  calls: z.number().int().nonnegative(),
  open: z.number().int().nonnegative(),
  spent_microcents: z.number().nonnegative(),
  input_tokens: z.number().nonnegative(),
  output_tokens: z.number().nonnegative(),
});

export const visitorAiSpendOp = defineOperation({
  name: "visitor_ai.spend",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_public",
  input: z.object({}).strict(),
  output: z.object({
    /** Spent in the last 24 hours and 30 days, USD; running conversations at their reserved worst case. */
    last24hUsd: z.number(),
    last30dUsd: z.number(),
    perOperation: z.array(
      z.object({
        pluginId: z.string(),
        operation: z.string(),
        turns: z.number(),
        running: z.number(),
        last30dUsd: z.number(),
        inputTokens: z.number(),
        outputTokens: z.number(),
      }),
    ),
    /** Rows the gateway's ledger held that failed validation (it is attacker-writable, #635). */
    dropped: z.number(),
  }),
  handler: async (_ctx, _input, tx) => {
    // The amount a row counts: a running turn its reservation, a finished one its cost.
    const amount = sql`CASE WHEN reservation = 'reserved' THEN reserved_microcents ELSE cost_microcents END`;
    const totals = (await tx.execute(sql`
      SELECT coalesce(sum(${amount}) FILTER (WHERE created_at > now() - interval '24 hours'), 0)::float8 AS day,
             coalesce(sum(${amount}), 0)::float8 AS month
      FROM visitor_ai_calls WHERE created_at > now() - interval '30 days'
    `)) as unknown as { day: number; month: number }[];
    const raw = (await tx.execute(sql`
      SELECT plugin_id::text AS plugin_id, operation, count(*)::int AS calls,
             count(*) FILTER (WHERE reservation = 'reserved')::int AS open,
             coalesce(sum(${amount}), 0)::float8 AS spent_microcents,
             coalesce(sum(input_tokens), 0)::float8 AS input_tokens,
             coalesce(sum(output_tokens), 0)::float8 AS output_tokens
      FROM visitor_ai_calls WHERE created_at > now() - interval '30 days'
      GROUP BY plugin_id, operation ORDER BY 5 DESC LIMIT 50
    `)) as unknown as unknown[];
    const parsed = parseUntrustedRows("visitor_ai.spend", spendRow, raw);
    const t = totals[0];
    const dollars = (v: unknown) =>
      Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) / MICROCENTS_PER_USD : 0;
    return ok({
      last24hUsd: dollars(t?.day),
      last30dUsd: dollars(t?.month),
      perOperation: parsed.rows.map((r) => ({
        pluginId: r.plugin_id,
        operation: r.operation,
        turns: r.calls,
        running: r.open,
        last30dUsd: r.spent_microcents / MICROCENTS_PER_USD,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
      })),
      dropped: parsed.dropped,
    });
  },
});
