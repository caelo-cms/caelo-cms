// SPDX-License-Identifier: MPL-2.0

/**
 * PluginAi — `ctx.ai.complete` for Tier-1 plugins, wrapping the host's
 * configured AIProvider.
 *
 * Three things happen around the provider call:
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

import type { PluginAi } from "@caelo-cms/plugin-sdk";
import { execute } from "@caelo-cms/query-api";
import { recordCapLookupFailure, recordCapLookupSuccess } from "@caelo-cms/shared";
import { z } from "zod";
import type { LoadedPlugin, PluginHostInfra } from "./dispatch.js";

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
    messages: z
      .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() }).strict())
      .min(1),
    maxTokens: z.number().int().positive().max(200_000).optional(),
    temperature: z.number().min(0).max(2).optional(),
    purpose: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,39}$/, "purpose is a lowercase identifier, e.g. 'translation'")
      .optional(),
  })
  .strict();

/** Build the `ctx.ai` handle for one plugin. */
export function makePluginAi(plugin: LoadedPlugin, infra: PluginHostInfra): PluginAi {
  return {
    complete: async (rawOpts) => {
      const provider = infra.aiProvider;
      if (!provider) {
        throw new Error("ctx.ai.complete: no AI provider configured on the host");
      }
      const parsed = pluginAiCompleteInput.safeParse(rawOpts);
      if (!parsed.success) {
        throw new Error(
          `ctx.ai.complete: invalid options — ${parsed.error.issues
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("; ")}`,
        );
      }
      const opts = parsed.data;
      await assertWithinPluginCap(plugin, infra);
      const startedAt = Date.now();
      const result = await provider.complete(opts);
      await recordPluginAiCall(plugin, infra, result, Date.now() - startedAt);
      return {
        text: result.text,
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
          `PluginAiCapExceeded: plugin '${plugin.slug}' has spent $${spentUsd} of $${capUsd} cap in the last 24h. Owner can raise the cap at /security/plugins/${plugin.slug}.`,
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
    `PluginAiCapLookupUnavailable: cap-lookup for plugin '${slug}' has failed repeatedly; failing closed to protect the daily budget. Investigate /security/costs.`,
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
  result: Awaited<ReturnType<NonNullable<PluginHostInfra["aiProvider"]>["complete"]>>,
  durationMs: number,
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
