// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { AI_DELEGATED_ERROR_PREFIX } from "@caelo-cms/plugin-sdk";
import type { LoadedPlugin, PluginHostInfra } from "./dispatch.js";
import { makePluginAi, pluginAiCompleteInput } from "./plugin-ai.js";

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
