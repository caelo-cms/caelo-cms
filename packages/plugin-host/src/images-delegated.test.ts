// SPDX-License-Identifier: MPL-2.0

/**
 * #741 — on an AI-delegated call (Power-MCP without the token's opt-in) a
 * plugin cannot generate or edit images on the install's image model; the
 * calling agent makes and uploads its own.
 */

import { describe, expect, it } from "bun:test";
import { AI_DELEGATED_ERROR_PREFIX } from "@caelo-cms/plugin-sdk";
import type { LoadedPlugin, PluginHostInfra } from "./dispatch.js";
import { makePluginImages } from "./images.js";

describe("ctx.images on an AI-delegated call", () => {
  it("refuses generate before any permission, ledger or provider work", async () => {
    let touched = 0;
    const infra = new Proxy(
      {},
      {
        get: () => {
          touched += 1;
          throw new Error("host infra must not be used");
        },
      },
    ) as PluginHostInfra;
    const plugin = { slug: "imagery", pluginId: crypto.randomUUID() } as LoadedPlugin;
    const images = makePluginImages(plugin, infra, {
      origin: "chat",
      actorId: crypto.randomUUID(),
      operatorActorId: crypto.randomUUID(),
      aiDelegated: true,
    });
    await expect(
      images.generate({
        requestId: crypto.randomUUID(),
        prompt: "a lighthouse at dusk",
        imageSize: "1K",
        references: [],
        maxCostMicrocents: 1_000_000,
      }),
    ).rejects.toThrow(AI_DELEGATED_ERROR_PREFIX);
    expect(touched).toBe(0);
  });
});
