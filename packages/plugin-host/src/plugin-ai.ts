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
 *   2. #1653 — the call's worst-case cost is reserved in the AI spend
 *      ledger before dispatch (`ai_ledger.reserve`): the site and per-person
 *      text budgets, the session budget of the chat it runs for, and the
 *      plugin's own cap, all under one lock, so parallel calls (a
 *      translation fan-out) cannot overshoot any of them.
 *   3. The finished call settles the reservation at its real cost, on the
 *      provider + model it actually ran on; a call that threw before the
 *      provider billed releases it.
 */

import {
  AI_DELEGATED_ERROR_PREFIX,
  type PluginAi,
  type PluginInvocation,
} from "@caelo-cms/plugin-sdk";
import { execute } from "@caelo-cms/query-api";
import {
  promptTokenBound,
  recordCapLookupFailure,
  recordCapLookupSuccess,
} from "@caelo-cms/shared";
import { z } from "zod";
import type { LoadedPlugin, PluginHostInfra } from "./dispatch.js";
import type { AICompletion, AIObjectCompletion } from "./types.js";

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";

/**
 * The output ceilings a call without `maxTokens` runs with, passed to the
 * provider explicitly so the reservation covers exactly what can be billed.
 */
export const PLUGIN_COMPLETE_DEFAULT_MAX_TOKENS = 32_768;
export const PLUGIN_OBJECT_DEFAULT_MAX_TOKENS = 8_192;

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
  // The person the call is for: their per-person budget counts it. Workers,
  // observers and renders act for nobody (the system actor).
  const person =
    invocation.origin === "chat"
      ? (invocation.operatorActorId ?? null)
      : invocation.origin === "owner-panel" || invocation.origin === "approved"
        ? invocation.actorId
        : null;
  const spender = {
    kind: "plugin" as const,
    pluginId: plugin.pluginId,
    actorId: person ?? SYSTEM_ACTOR_ID,
    chatSessionId: invocation.chatTaskId ?? null,
  };
  /** Runs one provider call inside a reservation. */
  async function reserved<T extends AIObjectCompletion | AICompletion>(
    method: string,
    target: { provider: string; model: string },
    promptTokens: number,
    maxOutputTokens: number,
    call: () => Promise<T>,
  ): Promise<T> {
    const callId = await reservePluginAiCall(plugin, infra, method, {
      spender,
      provider: target.provider,
      model: target.model,
      request: { promptTokens, maxOutputTokens },
    });
    const startedAt = Date.now();
    let result: T;
    try {
      result = await call();
    } catch (e) {
      if (callId) await settlePluginAiCall(plugin, infra, callId, null, Date.now() - startedAt);
      throw e;
    }
    const durationMs = Date.now() - startedAt;
    if (callId) await settlePluginAiCall(plugin, infra, callId, result, durationMs);
    else await recordPluginAiCall(plugin, infra, result, durationMs, invocation.chatTaskId ?? null);
    return result;
  }
  return {
    complete: async (rawOpts) => {
      const provider = preflight("complete");
      const opts = parseOptions(pluginAiCompleteInput, rawOpts, "complete");
      const maxTokens = opts.maxTokens ?? PLUGIN_COMPLETE_DEFAULT_MAX_TOKENS;
      const target = await provider.resolve(opts.purpose);
      const result = await reserved(
        "complete",
        target,
        promptTokenBound(opts.system, opts.messages),
        maxTokens,
        () => provider.complete({ ...opts, maxTokens }),
      );
      return {
        text: result.text,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      };
    },
    generateObject: async (rawOpts) => {
      const provider = preflight("generateObject");
      const opts = parseOptions(pluginAiGenerateObjectInput, rawOpts, "generateObject");
      const maxTokens = opts.maxTokens ?? PLUGIN_OBJECT_DEFAULT_MAX_TOKENS;
      const target = await provider.resolve(opts.purpose);
      const result = await reserved(
        "generateObject",
        target,
        promptTokenBound(opts.system, opts.messages, opts.jsonSchema),
        maxTokens,
        () => provider.generateObject({ ...opts, maxTokens }),
      );
      if (result.failure) throw objectFailureError(result.failure, maxTokens);
      return {
        object: result.object,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      };
    },
  };
}

const ledgerCtx = (plugin: LoadedPlugin) => ({
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system" as const,
  requestId: `plugin-${plugin.slug}-ai`.slice(0, 64),
});

/**
 * #1653 — reserve a plugin call's worst-case cost. A refusal (a budget or
 * the plugin's cap is reached, an unpriced model under a cap) throws with
 * the ledger's message. A ledger that cannot be reached is let through once
 * or twice (the call is then recorded after it ran, as before the ledger)
 * and fails closed after `LOOKUP_FAIL_THRESHOLD` misses in a row
 * (shared/cap-failures.ts): silent bypass under sustained database
 * pressure would defeat the caps entirely.
 */
async function reservePluginAiCall(
  plugin: LoadedPlugin,
  infra: PluginHostInfra,
  method: string,
  input: Record<string, unknown>,
): Promise<string | null> {
  const capKey = `plugin:${plugin.slug}`;
  let r: Awaited<ReturnType<typeof execute>>;
  try {
    r = await execute(infra.registry, infra.adapter, ledgerCtx(plugin), "ai_ledger.reserve", {
      ...input,
      what: `plugin '${plugin.slug}''s ctx.ai.${method} call`,
    });
  } catch {
    if (recordCapLookupFailure(capKey)) throw capLookupUnavailable(plugin.slug);
    return null;
  }
  if (r.ok) {
    recordCapLookupSuccess(capKey);
    return (r.value as { callId: string }).callId;
  }
  if (r.error.kind === "HandlerError" && r.error.refusal) {
    recordCapLookupSuccess(capKey);
    throw new Error(`ctx.ai.${method}: ${r.error.message}`);
  }
  if (recordCapLookupFailure(capKey)) throw capLookupUnavailable(plugin.slug);
  return null;
}

/** Settle a reservation at the call's real cost; `null` = it threw before billing. */
async function settlePluginAiCall(
  plugin: LoadedPlugin,
  infra: PluginHostInfra,
  callId: string,
  result: AIObjectCompletion | AICompletion | null,
  durationMs: number,
): Promise<void> {
  try {
    const r = result
      ? await execute(infra.registry, infra.adapter, ledgerCtx(plugin), "ai_ledger.settle", {
          callId,
          provider: result.provider,
          model: result.model,
          usage: {
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            cachedTokens: result.cachedTokens,
            cacheCreationTokens: result.cacheCreationTokens,
          },
          durationMs,
          succeeded: true,
        })
      : await execute(infra.registry, infra.adapter, ledgerCtx(plugin), "ai_ledger.release", {
          callId,
        });
    if (!r.ok) throw new Error(r.error.kind);
  } catch (e) {
    // The reservation stays at its worst case: spend is overstated, never
    // under, and it ages out of the 24-hour budgets.
    console.error("[plugin-ai] the AI spend reservation was not settled", {
      plugin: plugin.slug,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

function capLookupUnavailable(slug: string): Error {
  return new Error(
    `PluginAiCapLookupUnavailable: cap-lookup for plugin '${slug}' has failed repeatedly; failing closed to protect the daily budget. Investigate /settings/costs.`,
  );
}

/**
 * The error for a structured call that no retry of the same request can fix.
 * Thrown after the call is recorded: the provider has been paid either way.
 */
export function objectFailureError(
  failure: "refused" | "truncated",
  maxTokens: number | undefined,
): Error {
  return new Error(
    failure === "refused"
      ? "ctx.ai.generateObject: the model declined this request, and sending it again gets the same answer. Change the content, or choose another model for this purpose in Settings > AI."
      : `ctx.ai.generateObject: the answer was cut off at the token limit (maxTokens ${maxTokens ?? "default"}). Send less in one call, or raise maxTokens.`,
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
