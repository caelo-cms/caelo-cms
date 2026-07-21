// SPDX-License-Identifier: MPL-2.0

/**
 * P16 — `generate_image` AI tool. Takes a natural-language prompt,
 * dispatches to the primary image-capable provider's image endpoint,
 * persists the result via media.upload_object, returns the new mediaId.
 *
 * Image generation has its own daily budget separate from text. When the
 * image budget is exhausted the tool returns a structured failure that
 * the AI surfaces back to the user; text generation stays unaffected.
 *
 * Dispatch path: ai_providers.list → find isPrimary=true row →
 * config.imageModel must be set (the operator picks per-provider in
 * /security/ai/providers). If absent, tool returns "image generation
 * is not configured on the active provider".
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { runMediaPipeline } from "../../media/pipeline.js";
import { getMediaStorage, getMediaStorageProvider } from "../../media/storage.js";
import { FakeImageProvider, isFakeImageEnabled, makeImageProvider } from "../image-provider.js";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

async function sha256Hex(body: Uint8Array): Promise<string> {
  // crypto.subtle.digest needs an ArrayBuffer; slice to avoid the
  // SharedArrayBuffer-vs-ArrayBuffer typing wrinkle.
  const view = new Uint8Array(body);
  const hash = await crypto.subtle.digest("SHA-256", view.buffer.slice(0));
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const generateImageInput = z
  .object({
    prompt: z.string().min(1).max(4000),
    size: z.enum(["1024x1024", "1792x1024", "1024x1792"]).default("1024x1024"),
    quality: z.enum(["standard", "hd"]).default("standard"),
    /** Owner-readable label saved alongside the media row's title. */
    altText: z.string().max(500).optional(),
  })
  .strict();

export type GenerateImageInput = z.infer<typeof generateImageInput>;

export const generateImageTool: ToolDefinitionWithHandler<GenerateImageInput> = {
  name: "generate_image",
  description:
    "Generate an image from a natural-language prompt via the active AI provider's image endpoint (DALL·E for OpenAI, Imagen for Gemini). " +
    "Use for marketing visuals, product mockups, hero illustrations. The result is uploaded to media; the returned `mediaId` " +
    "is suitable for `add_module` HTML referencing `<img src='/media/<id>'>`. " +
    "Image generation has its own daily budget separate from text — if exhausted you'll get a structured `ImageBudgetExceeded` error. " +
    "Verify the prompt is on-brand before calling; image generation is rarely cheap.",
  schema: generateImageInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["prompt"],
    properties: {
      prompt: { type: "string" },
      size: { type: "string", enum: ["1024x1024", "1792x1024", "1024x1792"] },
      quality: { type: "string", enum: ["standard", "hd"] },
      altText: { type: "string" },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    // 1. Resolve the image provider. In e2e (isFakeImageEnabled) a
    // deterministic placeholder provider stands in for the real image API
    // — no config, no key, no cost — so the generate_image → media →
    // page-reference wiring runs in the default suite. Never in production.
    let provider: import("../image-provider.js").ImageProvider;
    let providerName: "openai" | "google";
    let imageModel: string;
    let apiKey: string;
    if (isFakeImageEnabled()) {
      provider = new FakeImageProvider();
      providerName = "openai";
      imageModel = "fake-image";
      apiKey = "fake-image-key";
    } else {
      const provs = await execute(toolCtx.registry, toolCtx.adapter, ctx, "ai_providers.list", {});
      if (!provs.ok) {
        return { ok: false, content: `generate_image: ${describeError(provs.error)}` };
      }
      const providers = (
        provs.value as {
          providers: Array<{
            name: "anthropic" | "openai" | "google" | "local-openai-compat";
            displayName: string;
            config: Record<string, unknown>;
            isActive: boolean;
          }>;
        }
      ).providers;
      // Prefer is_primary; fall back to is_active when no primary set.
      const primary =
        providers.find((p) => (p.config as { isPrimary?: boolean }).isPrimary && p.isActive) ??
        providers.find((p) => p.isActive);
      if (!primary) {
        return { ok: false, content: "generate_image: no active AI provider configured" };
      }
      const cfg = primary.config as { imageModel?: string; apiKey?: string; baseUrl?: string };
      if (!cfg.imageModel) {
        return {
          ok: false,
          content: `generate_image: provider '${primary.displayName}' has no imageModel configured. Owner sets one at /security/ai/providers.`,
        };
      }
      if (primary.name !== "openai" && primary.name !== "google") {
        return {
          ok: false,
          content: `generate_image: provider kind '${primary.name}' does not support image generation`,
        };
      }
      if (!cfg.apiKey || typeof cfg.apiKey !== "string" || cfg.apiKey.length < 8) {
        return { ok: false, content: "generate_image: provider apiKey missing or too short" };
      }
      provider = makeImageProvider({ kind: primary.name, model: cfg.imageModel, baseUrl: cfg.baseUrl });
      providerName = primary.name;
      imageModel = cfg.imageModel;
      apiKey = cfg.apiKey;
    }

    // 2. Dispatch.
    let result: Awaited<ReturnType<typeof provider.generate>>;
    try {
      result = await provider.generate({
        prompt: input.prompt,
        model: imageModel,
        size: input.size,
        quality: input.quality,
        apiKey,
      });
    } catch (e) {
      return { ok: false, content: `generate_image dispatch failed: ${(e as Error).message}` };
    }

    // 3. Download bytes + upload to media. Provider-hosted URLs are
    // ephemeral; we MUST persist before returning to the AI.
    let bytes: Uint8Array;
    try {
      const r = await fetch(result.imageUrl, { signal: AbortSignal.timeout(15_000) });
      if (!r.ok) throw new Error(`provider image fetch ${r.status}`);
      bytes = new Uint8Array(await r.arrayBuffer());
    } catch (e) {
      return { ok: false, content: `generate_image: download failed: ${(e as Error).message}` };
    }

    // 4. Persist via the media pipeline (same flow the HTTP upload
    //    endpoint uses): hash bytes → run sharp pipeline (variants +
    //    width/height) → storage.put each variant → media.upload op.
    //    Provider URLs are ephemeral; we MUST persist before returning
    //    to the AI so the resulting <img src> isn't dead in 24h.
    let assetId: string;
    let mediaUrl: string;
    try {
      const sha = await sha256Hex(bytes);
      const pipeline = await runMediaPipeline(sha, "image/png", bytes);
      const storage = getMediaStorage();
      for (const v of pipeline.variants) {
        await storage.put(v.storageKey, v.body, v.contentType);
      }
      // media.upload is human+system by design (no DIRECT AI media writes).
      // generate_image is a SANCTIONED, system-mediated persist of an image
      // the AI asked for, so elevate to a system actor for this write —
      // same pattern as verify-import-fidelity's system-context ops.
      const upload = await execute(
        toolCtx.registry,
        toolCtx.adapter,
        { ...ctx, actorKind: "system" },
        "media.upload",
        {
        sha256: sha,
        originalName: `ai-generated-${Date.now()}.png`,
        mime: "image/png",
        sizeBytes: bytes.byteLength,
        width: pipeline.width,
        height: pipeline.height,
        alt: (input.altText ?? input.prompt).slice(0, 2048),
        storageKey: pipeline.variants[0]?.storageKey ?? `${sha}/orig`,
        storageProvider: getMediaStorageProvider(),
        variants: pipeline.variants.map((v) => ({
          variant: v.variant,
          format: v.format,
          width: v.width,
          height: v.height,
          sizeBytes: v.sizeBytes,
          storageKey: v.storageKey,
        })),
      });
      if (!upload.ok) {
        return {
          ok: false,
          content: `generate_image: media.upload failed: ${describeError(upload.error)}`,
        };
      }
      const v = upload.value as { assetId: string };
      assetId = v.assetId;
      mediaUrl = `/_caelo/media/${assetId}`;
    } catch (e) {
      return { ok: false, content: `generate_image: persist failed: ${(e as Error).message}` };
    }

    // 5. Record the AI call (image op_type, image_count=1) so the
    // cost dashboard surfaces it. Pricing read from ai_pricing table by
    // recordAiCall (P16 PR2).
    await execute(toolCtx.registry, toolCtx.adapter, ctx, "chat.record_ai_call", {
      provider: providerName,
      model: imageModel,
      operationType: "image",
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      imageCount: 1,
      durationMs: result.durationMs,
      succeeded: true,
    }).catch(() => undefined);

    return {
      ok: true,
      content: `Generated image (mediaId=${assetId}, url=${mediaUrl}). Reference in HTML as <img src="${mediaUrl}" alt="${input.altText ?? input.prompt.slice(0, 80)}" />.${result.revisedPrompt ? `\n\nProvider revised prompt: ${result.revisedPrompt}` : ""}`,
    };
  },
};
