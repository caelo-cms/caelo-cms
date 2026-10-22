// SPDX-License-Identifier: MPL-2.0

/**
 * PluginAi — `ctx.ai.complete` (text) and `ctx.ai.generateObject`
 * (structured output) for Tier-1 plugins, wrapping the host's configured
 * AIProvider.
 *
 * Three things happen around either provider call:
 *   1. The plugin's options are validated (Zod at the SDK boundary). The
 *      declared `purpose` is passed through; the provider maps it to the
 *      Owner's per-purpose model (#593). A purpose the host has no setting
 *      for runs on the chat model — the purpose is a declaration of use,
 *      not a model choice, so plugins can never pick a model themselves.
 *   2. The per-plugin daily cost cap is checked before dispatch.
 *   3. The finished call is recorded in `ai_calls` with the plugin id and
 *      the provider + model it actually ran on, so the cost dashboard and
 *      the cap both see plugin text spend.
 */

import {
  AI_DELEGATED_ERROR_PREFIX,
  type PluginAi,
  type PluginInvocation,
} from "@caelo-cms/plugin-sdk";
import { execute } from "@caelo-cms/query-api";
import { recordCapLookupFailure, recordCapLookupSuccess } from "@caelo-cms/shared";
import { z } from "zod";
import type { LoadedPlugin, PluginHostInfra } from "./dispatch.js";
import type { AICompletion, AIObjectCompletion } from "./types.js";

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";

/**
 * Shape of the options a plugin passes to `ctx.ai.complete`. `purpose` is
 * an identifier rather than an enum so a plugin built against a newer SDK
 * (declaring a purpose this host has no setting for) still runs — on the
 * chat model, which is what "no per-purpose model" means.
 */
export const pluginAiCompleteInput = z
  .object({
    system: z.string(),
    messages: z.array(
      z.object({ role: z.enum(["user", "assistant"]), content: z.string() }).strict(),
    ),
    maxTokens: z.number().int().positive().max(200_000).optional(),
    temperature: z.number().min(0).max(2).optional(),
    purpose: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,39}$/, "purpose is a lowercase identifier, e.g. 'translation'")
      .optional(),
  })
  .strict();

/**
 * `ctx.ai.generateObject` options: the text options plus the JSON Schema
 * the answer is constrained to. The schema must describe an object — the
 * structured-output contract returns ONE object.
 */
export const pluginAiGenerateObjectInput = pluginAiCompleteInput
  .extend({
    jsonSchema: z
      .record(z.string(), z.unknown())
      .refine((s) => s.type === "object", "jsonSchema must describe an object (type: 'object')"),
  })
  .strict();

/** Zod-parse plugin-supplied options, failing with the field paths. */
function parseOptions<T>(schema: z.ZodType<T>, raw: unknown, method: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `ctx.ai.${method}: invalid options — ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

/**
 * Build the `ctx.ai` handle for one plugin call.
 *
 * @param invocation who the call acts for. Its `chatTaskId` (the chat
 *   session, by the chat-runner's convention) attributes the spend to that
 *   session, so a Power-MCP token's cost cap sees plugin text spend too.
 *   `aiDelegated` (#741) makes every call fail: the external agent does the
 *   AI work and the plugin hands it a work item instead.
 */
export function makePluginAi(
  plugin: LoadedPlugin,
  infra: PluginHostInfra,
  invocation: PluginInvocation,
): PluginAi {
  /** The checks every call runs before it may reach the provider. */
  const preflight = (method: string): NonNullable<PluginHostInfra["aiProvider"]> => {
    if (invocation.aiDelegated) {
      throw new Error(
        `${AI_DELEGATED_ERROR_PREFIX} plugin '${plugin.slug}' called ctx.ai.${method} on a call whose AI work belongs to the calling agent (Power-MCP, issue #741). The operation must return an AiWorkItem instead; this is a bug in the plugin.`,
      );
    }
    const provider = infra.aiProvider;
    if (!provider) {
      throw new Error(`ctx.ai.${method}: no AI provider configured on the host`);
    }
    return provider;
  };
  const record = (result: AIObjectCompletion | AICompletion, startedAt: number) =>
    recordPluginAiCall(
      plugin,
      infra,
      result,
      Date.now() - startedAt,
      invocation.chatTaskId ?? null,
    );
  return {
    complete: async (rawOpts) => {
      const provider = preflight("complete");
      const opts = parseOptions(pluginAiCompleteInput, rawOpts, "complete");
      await assertWithinPluginCap(plugin, infra);
      const startedAt = Date.now();
      const result = await provider.complete(opts);
      await record(result, startedAt);
      return {
        text: result.text,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      };
    },
    generateObject: async (rawOpts) => {
      const provider = preflight("generateObject");
      const opts = parseOptions(pluginAiGenerateObjectInput, rawOpts, "generateObject");
      await assertWithinPluginCap(plugin, infra);
      const startedAt = Date.now();
      const result = await provider.generateObject(opts);
      await record(result, startedAt);
      return {
        object: result.object,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      };
    },
  };
}

/**
 * P11.6 + P16 — per-plugin AI cost cap pre-flight. Without this a
 * misbehaving Tier-1 plugin could drain the daily AI budget with no
 * per-plugin attribution. The `plugins.ai_cost_cap_microcents` column is
 * NULL by default (uncapped). Lookup failures are swallowed once or twice
 * (a DB hiccup shouldn't break a working plugin) but trip fail-closed
 * after `LOOKUP_FAIL_THRESHOLD` consecutive misses — silent bypass under
 * sustained DB pressure would defeat enforcement entirely.
 */
async function assertWithinPluginCap(plugin: LoadedPlugin, infra: PluginHostInfra): Promise<void> {
  const capKey = `plugin:${plugin.slug}`;
  try {
    const r = await execute(
      infra.registry,
      infra.adapter,
      {
        actorId: SYSTEM_ACTOR_ID,
        actorKind: "system",
        requestId: `plugin-${plugin.slug}-ai-cap`,
      },
      "ai_calls.aggregate_per_plugin",
      { pluginId: plugin.pluginId },
    );
    if (r.ok) {
      recordCapLookupSuccess(capKey);
      const v = r.value as {
        capExceeded: boolean;
        capMicrocents: number | null;
        last24hMicrocents: number;
      };
      if (v.capExceeded) {
        const capUsd = v.capMicrocents !== null ? (v.capMicrocents / 1e8).toFixed(2) : "0";
        const spentUsd = (v.last24hMicrocents / 1e8).toFixed(2);
        throw new Error(
          `PluginAiCapExceeded: plugin '${plugin.slug}' has spent $${spentUsd} of $${capUsd} cap in the last 24h. Owner can raise the cap at /settings/plugins/${plugin.slug}.`,
        );
      }
    } else if (recordCapLookupFailure(capKey)) {
      throw capLookupUnavailable(plugin.slug);
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("PluginAiCapExceeded:")) throw e;
    if (e instanceof Error && e.message.startsWith("PluginAiCapLookupUnavailable:")) throw e;
    if (recordCapLookupFailure(capKey)) throw capLookupUnavailable(plugin.slug);
  }
}

function capLookupUnavailable(slug: string): Error {
  return new Error(
    `PluginAiCapLookupUnavailable: cap-lookup for plugin '${slug}' has failed repeatedly; failing closed to protect the daily budget. Investigate /settings/costs.`,
  );
}

/**
 * Record the finished call in `ai_calls`, priced by `chat.record_ai_call`
 * from the pricing table for the model that actually ran. A recording
 * failure is logged, not thrown: the provider has already been paid, and
 * failing the plugin operation now would only make the caller retry and
 * pay again.
 */
async function recordPluginAiCall(
  plugin: LoadedPlugin,
  infra: PluginHostInfra,
  result: AIObjectCompletion | AICompletion,
  durationMs: number,
  chatSessionId: string | null,
): Promise<void> {
  const requestId = `plugin-${plugin.slug}-ai`.slice(0, 64);
  try {
    const r = await execute(
      infra.registry,
      infra.adapter,
      { actorId: SYSTEM_ACTOR_ID, actorKind: "system", requestId },
      "chat.record_ai_call",
      {
        provider: result.provider,
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cachedTokens: result.cachedTokens,
        cacheCreationTokens: result.cacheCreationTokens,
        durationMs,
        pluginId: plugin.pluginId,
        chatSessionId,
        requestId,
      },
    );
    if (!r.ok) throw new Error(`${r.error.kind}`);
  } catch (e) {
    console.error("[plugin-ai] ai_calls row not recorded — plugin spend is understated", {
      plugin: plugin.slug,
      provider: result.provider,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
