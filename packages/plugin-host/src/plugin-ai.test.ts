// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { AI_DELEGATED_ERROR_PREFIX } from "@caelo-cms/plugin-sdk";
import type { LoadedPlugin, PluginHostInfra } from "./dispatch.js";
import { makePluginAi, pluginAiCompleteInput, pluginAiGenerateObjectInput } from "./plugin-ai.js";

const base = { system: "s", messages: [{ role: "user", content: "hi" }] };

describe("ctx.ai.complete options (#593)", () => {
  it("accepts a declared purpose", () => {
    expect(pluginAiCompleteInput.safeParse({ ...base, purpose: "translation" }).success).toBe(true);
  });

  it("accepts a purpose the host has no setting for (it runs on the chat model)", () => {
    expect(pluginAiCompleteInput.safeParse({ ...base, purpose: "summarize" }).success).toBe(true);
  });

  it("accepts an empty message list (the SDK contract allows a system-only call)", () => {
    expect(pluginAiCompleteInput.safeParse({ system: "s", messages: [] }).success).toBe(true);
  });

  it("rejects a purpose that is not an identifier", () => {
    expect(pluginAiCompleteInput.safeParse({ ...base, purpose: "Translation!" }).success).toBe(
      false,
    );
  });

  it("rejects a plugin trying to pick the model itself", () => {
    expect(pluginAiCompleteInput.safeParse({ ...base, model: "claude-opus-5-5" }).success).toBe(
      false,
    );
  });
});

describe("ctx.ai on an AI-delegated call (#741)", () => {
  it("refuses before the provider or the cost-cap lookup is reached", async () => {
    let providerCalls = 0;
    let dbCalls = 0;
    const infra = {
      aiProvider: {
        complete: async () => {
          providerCalls += 1;
          throw new Error("provider must not be called");
        },
      },
      registry: {},
      adapter: {
        withAdminTransaction: async () => {
          dbCalls += 1;
          throw new Error("database must not be touched");
        },
      },
    } as unknown as PluginHostInfra;
    const plugin = { slug: "international-site", pluginId: crypto.randomUUID() } as LoadedPlugin;
    const ai = makePluginAi(plugin, infra, {
      origin: "chat",
      actorId: crypto.randomUUID(),
      aiDelegated: true,
    });
    await expect(ai.complete(base as never)).rejects.toThrow(AI_DELEGATED_ERROR_PREFIX);
    expect(providerCalls).toBe(0);
    expect(dbCalls).toBe(0);
  });
});

const objectSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdict"],
  properties: { verdict: { type: "string", enum: ["ok", "spam"] } },
};

describe("ctx.ai.generateObject (structured output, CLAUDE.md §12)", () => {
  it("requires a JSON Schema describing an object", () => {
    expect(
      pluginAiGenerateObjectInput.safeParse({ ...base, jsonSchema: objectSchema }).success,
    ).toBe(true);
    expect(pluginAiGenerateObjectInput.safeParse(base).success).toBe(false);
    expect(
      pluginAiGenerateObjectInput.safeParse({ ...base, jsonSchema: { type: "string" } }).success,
    ).toBe(false);
  });

  it("hands schema + purpose to the provider and returns its object", async () => {
    const seen: unknown[] = [];
    const infra = {
      aiProvider: {
        complete: async () => {
          throw new Error("text path must not be used");
        },
        generateObject: async (opts: unknown) => {
          seen.push(opts);
          return {
            object: { verdict: "ok" },
            inputTokens: 3,
            outputTokens: 2,
            cachedTokens: 0,
            cacheCreationTokens: 0,
            provider: "anthropic",
            model: "test-model",
          };
        },
      },
      // No real database: the cap lookup and the ai_calls record fail and
      // are tolerated (one miss, logged) — this test is about the call.
      registry: {},
      adapter: {},
    } as unknown as PluginHostInfra;
    const plugin = { slug: "comments", pluginId: crypto.randomUUID() } as LoadedPlugin;
    const ai = makePluginAi(plugin, infra, { origin: "chat", actorId: crypto.randomUUID() });
    const r = await ai.generateObject({
      ...(base as never),
      jsonSchema: objectSchema,
      purpose: "translation",
    });
    expect(r).toEqual({ object: { verdict: "ok" }, inputTokens: 3, outputTokens: 2 });
    expect(seen[0]).toMatchObject({ jsonSchema: objectSchema, purpose: "translation" });
  });

  it("refuses on an AI-delegated call before the provider is reached", async () => {
    let providerCalls = 0;
    const infra = {
      aiProvider: {
        complete: async () => {
          providerCalls += 1;
          throw new Error("provider must not be called");
        },
        generateObject: async () => {
          providerCalls += 1;
          throw new Error("provider must not be called");
        },
      },
      registry: {},
      adapter: {},
    } as unknown as PluginHostInfra;
    const plugin = { slug: "international-site", pluginId: crypto.randomUUID() } as LoadedPlugin;
    const ai = makePluginAi(plugin, infra, {
      origin: "chat",
      actorId: crypto.randomUUID(),
      aiDelegated: true,
    });
    await expect(
      ai.generateObject({ ...(base as never), jsonSchema: objectSchema }),
    ).rejects.toThrow(AI_DELEGATED_ERROR_PREFIX);
    expect(providerCalls).toBe(0);
  });
});
