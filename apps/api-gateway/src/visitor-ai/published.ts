// SPDX-License-Identifier: MPL-2.0

/**
 * What the admin published for the visitor AI (#1654), read by the gateway
 * as untrusted (cms_public is attacker-writable, #635): every row parsed
 * with a strict, bounded schema, a row that does not fit is refused, never
 * coerced.
 *
 *   published_visitor_ai             this environment's settings (the
 *                                    `settings` section);
 *   published_plugin_visitor_config  each plugin's released visitor-visible
 *                                    configuration (the `plugins` section).
 *
 * Both are cached while the LISTEN on the admin's publish notifications
 * holds and dropped on every notification (published-changes.ts), like the
 * gateway's other published state: a lowered budget binds on the next turn.
 */

import type { DatabaseAdapter } from "@caelo-cms/query-api";
import { type PricingCandidate, type PricingRow, pickPricingRow } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  mayCacheRead,
  onPublishedChange,
  publishedCacheGeneration,
  publishedCacheUsable,
} from "../published-changes.js";

const SYSTEM_CTX = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system" as const,
  requestId: "gateway-visitor-ai",
};

const PROVIDERS = ["anthropic", "openai", "google"] as const;
export type VisitorAiProvider = (typeof PROVIDERS)[number];

const money = z.coerce.number().int().min(0).max(1e14);
const rate = z.number().min(0).max(1e9).nullable();

const candidate = z
  .object({
    model: z.string().max(120),
    inputMicrocents: z.number().min(0).max(1e9),
    outputMicrocents: rate,
    cachedMicrocents: rate,
    cacheCreationMicrocents: rate,
    longPromptThresholdTokens: z.number().int().positive().nullable(),
    longPromptMultiplier: z.number().int().min(2).max(100).nullable(),
    effectiveFromMs: z.number(),
    validFromMs: z.number().nullable(),
    validToMs: z.number().nullable(),
  })
  .strict();

const settingsRow = z
  .object({
    enabled: z.boolean(),
    provider: z.enum(PROVIDERS),
    model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/),
    pricing: z.array(candidate).max(50).nullable(),
    daily_cap_microcents: money,
    monthly_cap_microcents: money,
    conversation_cap_microcents: money,
    max_concurrent: z.number().int().min(1).max(500),
    max_turns: z.number().int().min(1).max(20).nullable(),
    max_question_chars: z.number().int().min(20).max(2000).nullable(),
    max_answer_tokens: z.number().int().min(64).max(2000).nullable(),
    key_provider: z.enum(PROVIDERS).nullable(),
  })
  .strict();

/** This environment's visitor-AI settings, as published. */
export interface PublishedVisitorAi {
  readonly enabled: boolean;
  readonly provider: VisitorAiProvider;
  readonly model: string;
  readonly pricing: readonly PricingCandidate[];
  readonly dailyCapMicrocents: number;
  readonly monthlyCapMicrocents: number;
  readonly conversationCapMicrocents: number;
  readonly maxConcurrent: number;
  readonly maxTurns: number | null;
  readonly maxQuestionChars: number | null;
  readonly maxAnswerTokens: number | null;
  /** Which provider the admin stored this environment's key for; null: none. */
  readonly keyProvider: VisitorAiProvider | null;
}

/** The pricing row in force now for the published model, or null (unpriced: refused). */
export function pricingNow(s: PublishedVisitorAi, now: number = Date.now()): PricingRow | null {
  return pickPricingRow(s.pricing, s.model, now);
}

type Loaded = { readonly settings: PublishedVisitorAi | null; readonly problem: string | null };

let cachedSettings: Loaded | null = null;
const cachedConfig = new Map<string, Record<string, unknown> | null>();
let listening = false;

function listen(): void {
  if (listening) return;
  listening = true;
  onPublishedChange(() => {
    cachedSettings = null;
    cachedConfig.clear();
  });
}

/**
 * This environment's settings: null with the reason when the admin
 * published none (or a row that does not parse, which is refused loudly).
 */
export async function loadVisitorAi(adapter: DatabaseAdapter): Promise<Loaded> {
  listen();
  if (cachedSettings && publishedCacheUsable()) return cachedSettings;
  const startedAt = publishedCacheGeneration();
  const rows = (await adapter.withPublicTransaction(SYSTEM_CTX, (tx) =>
    tx.execute(sql`
      SELECT enabled, provider, model, pricing, daily_cap_microcents::text AS daily_cap_microcents,
             monthly_cap_microcents::text AS monthly_cap_microcents,
             conversation_cap_microcents::text AS conversation_cap_microcents, max_concurrent,
             max_turns, max_question_chars, max_answer_tokens, key_provider
      FROM published_visitor_ai WHERE id = 1
    `),
  )) as unknown as unknown[];
  let loaded: Loaded;
  if (rows.length === 0) {
    loaded = {
      settings: null,
      problem:
        "the admin has published no visitor-AI settings for this environment (published_visitor_ai is empty); run the database migrations or start the admin",
    };
  } else {
    const parsed = settingsRow.safeParse(rows[0]);
    if (!parsed.success) {
      loaded = {
        settings: null,
        problem: `published_visitor_ai does not parse (${parsed.error.issues[0]?.path.join(".")}): refused`,
      };
    } else {
      const r = parsed.data;
      loaded = {
        problem: null,
        settings: {
          enabled: r.enabled,
          provider: r.provider,
          model: r.model,
          pricing: r.pricing ?? [],
          dailyCapMicrocents: r.daily_cap_microcents,
          monthlyCapMicrocents: r.monthly_cap_microcents,
          conversationCapMicrocents: r.conversation_cap_microcents,
          maxConcurrent: r.max_concurrent,
          maxTurns: r.max_turns,
          maxQuestionChars: r.max_question_chars,
          maxAnswerTokens: r.max_answer_tokens,
          keyProvider: r.key_provider,
        },
      };
    }
  }
  if (mayCacheRead(startedAt)) cachedSettings = loaded;
  return loaded;
}

const configValues = z.record(
  z.string().regex(/^[a-z][a-z0-9_]{0,47}(\.[a-z][a-z0-9_]{0,47}){0,2}$/),
  z.union([z.string().max(20_000), z.number(), z.boolean()]),
);

/**
 * A plugin's released visitor-visible configuration (leaf path → value), or
 * null when the release published none for it.
 */
export async function loadVisitorConfig(
  adapter: DatabaseAdapter,
  pluginId: string,
): Promise<Record<string, unknown> | null> {
  listen();
  if (publishedCacheUsable() && cachedConfig.has(pluginId))
    return cachedConfig.get(pluginId) ?? null;
  const startedAt = publishedCacheGeneration();
  const rows = (await adapter.withPublicTransaction(SYSTEM_CTX, (tx) =>
    tx.execute(sql`
      SELECT "values" AS v FROM published_plugin_visitor_config WHERE plugin_id = ${pluginId}::uuid
    `),
  )) as unknown as { v: unknown }[];
  const parsed = rows[0] ? configValues.safeParse(rows[0].v) : null;
  const value = parsed?.success ? parsed.data : null;
  if (mayCacheRead(startedAt)) cachedConfig.set(pluginId, value);
  return value;
}

/** Forget what was read (tests). */
export function resetVisitorAiCacheForTests(): void {
  cachedSettings = null;
  cachedConfig.clear();
}
