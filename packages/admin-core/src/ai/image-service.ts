// SPDX-License-Identifier: MPL-2.0

/**
 * The chat's image service (#527): `generate_image` (and `edit_image`)
 * run every request through the same lifecycle as plugin images —
 *
 *   resolve model → check capabilities → load references from the media
 *   library → reserve budget (shared ledger) → provider call → persist to
 *   the media library → settle the actual cost.
 *
 * The request id is derived from the tool call, so a replayed call finds
 * its recorded request instead of paying again. An outcome we cannot
 * confirm keeps its reservation and is reported as uncertain; it is never
 * retried automatically.
 */

import { createHash } from "node:crypto";
import { execute } from "@caelo-cms/query-api";
import { buildMediaUrl, type ExecutionContext, pickAiImageVariant } from "@caelo-cms/shared";
import { runMediaPipeline } from "../media/pipeline.js";
import { getMediaStorage, getMediaStorageProvider } from "../media/storage.js";
import {
  capabilityRefusal,
  type ImageCapabilities,
  imageCapabilities,
  imageReserveMicrocents,
  SUPPORTED_IMAGE_MODELS,
  settleImageCostMicrocents,
} from "./image-models.js";
import {
  FakeImageProvider,
  type ImageProvider,
  isFakeImageEnabled,
  makeImageProvider,
} from "./image-provider.js";
import { getImageProviderApiKey } from "./provider-resolver.js";
import { describeError } from "./tools/_describe-error.js";
import type { ToolContext } from "./tools/dispatch.js";

/** The configured image model, ready to call. */
export interface ConfiguredImageModel {
  provider: ImageProvider;
  providerName: "openai" | "google";
  model: string;
  apiKey: string;
  capabilities: ImageCapabilities;
  reserveMicrocents: number;
}

type ToolResult = { ok: boolean; content: string };

/**
 * Pick the image-capable provider (an active OpenAI/Google provider with
 * an image model; the primary one when several) and its model profile.
 */
export async function resolveImageModel(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
): Promise<ConfiguredImageModel | { error: string }> {
  if (isFakeImageEnabled()) {
    // e2e only — never in production (see isFakeImageEnabled).
    const capabilities = imageCapabilities("fake-image") as ImageCapabilities;
    return {
      provider: new FakeImageProvider(),
      providerName: "openai",
      model: "fake-image",
      apiKey: "fake-image-key",
      capabilities,
      reserveMicrocents: 1,
    };
  }
  const provs = await execute(toolCtx.registry, toolCtx.adapter, ctx, "ai_providers.list", {});
  if (!provs.ok) return { error: describeError(provs.error) };
  const providers = (
    provs.value as {
      providers: {
        name: "anthropic" | "openai" | "google" | "local-openai-compat";
        config: { imageModel?: string; isPrimary?: boolean; baseUrl?: string };
        isActive: boolean;
      }[];
    }
  ).providers;
  // Anthropic (the usual chat primary) cannot generate images, so image
  // generation needs its own active OpenAI/Google provider with a model.
  const capable = providers.filter(
    (p) =>
      p.isActive &&
      (p.name === "openai" || p.name === "google") &&
      typeof p.config.imageModel === "string" &&
      p.config.imageModel.length > 0,
  );
  const chosen = capable.find((p) => p.config.isPrimary) ?? capable[0];
  if (!chosen) {
    return {
      error:
        "no image-capable provider configured — needs an active OpenAI or Google provider with an image model. The Owner sets one at /security/ai.",
    };
  }
  const kind = chosen.name as "openai" | "google";
  const model = chosen.config.imageModel as string;
  const capabilities = imageCapabilities(model);
  const reserveMicrocents = imageReserveMicrocents(model);
  if (!capabilities || reserveMicrocents === null) {
    return {
      error: `the configured image model "${model}" is not supported (no capability or pricing profile). Supported: ${SUPPORTED_IMAGE_MODELS.join(", ")}. The Owner changes it at /security/ai.`,
    };
  }
  const apiKey = await getImageProviderApiKey(kind);
  if (!apiKey) return { error: "configure the image provider key at /security/ai" };
  return {
    provider: makeImageProvider({
      kind,
      model,
      ...(chosen.config.baseUrl ? { baseUrl: chosen.config.baseUrl } : {}),
    }),
    providerName: kind,
    model,
    apiKey,
    capabilities,
    reserveMicrocents,
  };
}

/** A media-library image used as a source or reference, with its bytes. */
export interface SourceImage {
  id: string;
  sha256: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  data: Uint8Array;
}

/**
 * Load media-library images by id or slug — any visibility, since
 * reference images (#531) exist for exactly this. Only raster PNG / JPEG /
 * WebP can be sent to a provider.
 */
export async function loadSourceImages(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
  refs: readonly string[],
): Promise<SourceImage[] | { error: string }> {
  const storage = getMediaStorage();
  const out: SourceImage[] = [];
  for (const ref of refs) {
    const got = await execute(toolCtx.registry, toolCtx.adapter, ctx, "media.get", {
      assetId: ref,
    });
    const asset = got.ok
      ? (
          got.value as {
            asset: { id: string; sha256: string; mime: string; storageKey: string } | null;
          }
        ).asset
      : null;
    if (!asset) return { error: `media "${ref}" not found — take ids from find_media` };
    if (!["image/png", "image/jpeg", "image/webp"].includes(asset.mime)) {
      return {
        error: `media "${ref}" is ${asset.mime}; only PNG, JPEG or WebP images can be used`,
      };
    }
    out.push({
      id: asset.id,
      sha256: asset.sha256,
      mediaType: asset.mime as SourceImage["mediaType"],
      data: await storage.get(asset.storageKey),
    });
  }
  return out;
}

const hex = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

/** A UUID-shaped id derived from the tool call — stable across replays. */
function requestIdFor(toolCallId: string): string {
  const h = hex(`image-request:${toolCallId}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** What a finished chat request returns to the AI (and on replay). */
function resultText(
  operation: "generate" | "edit",
  media: { assetId: string; url: string },
  alt: string,
  extra = "",
): string {
  const what = operation === "edit" ? "Edited image" : "Generated image";
  return `${what} (mediaId=${media.assetId}, url=${media.url}). Reference in HTML as <img src="${media.url}" alt="${alt}" />.${extra}`;
}

/**
 * Run one generate/edit request end to end. `sources` are the edit source
 * (first) and references, already loaded; the caller checked nothing else.
 */
export async function runImageRequest(args: {
  ctx: ExecutionContext;
  toolCtx: ToolContext;
  configured: ConfiguredImageModel;
  operation: "generate" | "edit";
  prompt: string;
  /** For an edit, the first source is the image being edited; the rest are references. */
  sources: readonly SourceImage[];
  /** #528 — PNG whose transparent area marks what an edit may change. */
  mask?: SourceImage;
  size?: "1024x1024" | "1792x1024" | "1024x1792";
  quality?: "standard" | "hd";
  imageSize?: "1K" | "2K" | "4K";
  altText?: string;
}): Promise<ToolResult> {
  const { ctx, toolCtx, configured } = args;
  const tool = args.operation === "edit" ? "edit_image" : "generate_image";
  if (!toolCtx.toolCallId || !toolCtx.chatSessionId) {
    // §2 fail loud: without the call and session there is no stable request
    // id, and a replay would pay twice.
    return { ok: false, content: `${tool}: needs a chat session and tool call id` };
  }
  if (args.operation === "edit" && args.sources.length === 0) {
    return { ok: false, content: "edit_image: name the image to edit as `source`" };
  }
  const refusal = capabilityRefusal(configured.capabilities, {
    operation: args.operation,
    references: args.sources.map((s) => ({ bytes: s.data.byteLength, mediaType: s.mediaType })),
    mask: args.mask !== undefined,
    ...(args.size ? { size: args.size } : {}),
    ...(args.imageSize ? { imageSize: args.imageSize } : {}),
  });
  if (refusal) return { ok: false, content: `${tool}: ${refusal} (see get_image_capabilities)` };
  if (args.mask && args.mask.mediaType !== "image/png") {
    return {
      ok: false,
      content: `${tool}: the mask must be a PNG with transparency marking the area to change`,
    };
  }

  const requested = {
    ...(args.size ? { size: args.size } : {}),
    ...(args.quality ? { quality: args.quality } : {}),
    ...(args.imageSize ? { imageSize: args.imageSize } : {}),
  };
  // Provenance: an edit's first source is the image it changes.
  const references = args.sources.map((s, i) => ({
    kind: args.operation === "edit" && i === 0 ? "source" : "media",
    id: s.id,
    sha256: s.sha256,
  }));
  const mask = args.mask ? { kind: "mask", id: args.mask.id, sha256: args.mask.sha256 } : undefined;
  const key = { chatSessionId: toolCtx.chatSessionId, requestId: requestIdFor(toolCtx.toolCallId) };
  const system: ExecutionContext = { ...ctx, actorKind: "system" };
  const alt = (args.altText ?? args.prompt).slice(0, 2048);

  const reserved = await execute(
    toolCtx.registry,
    toolCtx.adapter,
    system,
    "image_requests.reserve",
    {
      ...key,
      actorId: ctx.actorId,
      inputSha256: hex(
        JSON.stringify({
          op: args.operation,
          prompt: args.prompt,
          references,
          mask,
          requested,
          model: configured.model,
        }),
      ),
      operation: args.operation,
      prompt: args.prompt,
      references,
      ...(mask ? { mask } : {}),
      requested,
      provider: configured.providerName,
      model: configured.model,
      maxCostMicrocents: configured.reserveMicrocents,
    },
  );
  if (!reserved.ok) return { ok: false, content: `${tool}: ${describeError(reserved.error)}` };
  const value = reserved.value as {
    existing: { status: string; outputMediaId: string | null; result: unknown } | null;
    callId: string | null;
  };
  if (value.existing) {
    const r = value.existing.result as { assetId?: string; url?: string } | null;
    if (value.existing.status === "ready" && r?.assetId && r.url) {
      return {
        ok: true,
        content: resultText(args.operation, { assetId: r.assetId, url: r.url }, alt),
      };
    }
    return {
      ok: false,
      content: `${tool}: this request is ${value.existing.status}; its outcome is not confirmed. It was not retried, so nothing was paid twice. Generate again only if a NEW image is wanted.`,
    };
  }
  const callId = value.callId as string;

  try {
    const generated = await configured.provider.generate({
      prompt: args.prompt,
      model: configured.model,
      apiKey: configured.apiKey,
      ...(args.size ? { size: args.size } : {}),
      ...(args.quality ? { quality: args.quality } : {}),
      ...(args.imageSize ? { imageSize: args.imageSize } : {}),
      ...(args.operation === "edit"
        ? {
            editSource: { data: args.sources[0]!.data, mediaType: args.sources[0]!.mediaType },
            referenceImages: args.sources
              .slice(1)
              .map((s) => ({ data: s.data, mediaType: s.mediaType })),
            ...(args.mask
              ? { mask: { data: args.mask.data, mediaType: "image/png" as const } }
              : {}),
          }
        : args.sources.length
          ? {
              referenceImages: args.sources.map((s) => ({ data: s.data, mediaType: s.mediaType })),
            }
          : {}),
      abortSignal: AbortSignal.timeout(180_000),
    });
    // Provider URLs are ephemeral (data: or short-lived https): persist now.
    const download = await fetch(generated.imageUrl, { signal: AbortSignal.timeout(15_000) });
    if (!download.ok) throw new Error(`provider image fetch ${download.status}`);
    const bytes = new Uint8Array(await download.arrayBuffer());
    const sha = hex(bytes);
    const pipeline = await runMediaPipeline(sha, "image/png", bytes);
    const storage = getMediaStorage();
    for (const v of pipeline.variants) await storage.put(v.storageKey, v.body, v.contentType);
    // media.upload is human+system by design; this is the sanctioned,
    // system-mediated persist of an image the AI asked for.
    const upload = await execute(toolCtx.registry, toolCtx.adapter, system, "media.upload", {
      sha256: sha,
      originalName: `ai-${args.operation === "edit" ? "edited" : "generated"}-${Date.now()}.png`,
      name: (args.altText ?? args.prompt).slice(0, 200),
      mime: "image/png",
      sizeBytes: bytes.byteLength,
      width: pipeline.width,
      height: pipeline.height,
      alt,
      storageKey: pipeline.variants[0]?.storageKey ?? `${sha}/orig`,
      storageProvider: getMediaStorageProvider(),
      sourceKind: "ai_generated",
      // #528/#532 — an edit points at the image it was made from.
      ...(args.operation === "edit" ? { derivedFromId: args.sources[0]!.id } : {}),
      sourceDetail: `${configured.providerName}/${configured.model}`,
      license: "AI-generated",
      variants: pipeline.variants.map((v) => ({
        variant: v.variant,
        format: v.format,
        width: v.width,
        height: v.height,
        sizeBytes: v.sizeBytes,
        storageKey: v.storageKey,
      })),
    });
    if (!upload.ok) throw new Error(`media.upload failed: ${describeError(upload.error)}`);
    const media = upload.value as { assetId: string; slug: string };
    const url = buildMediaUrl(
      media.slug,
      pickAiImageVariant(pipeline.variants.map((v) => v.variant)),
    );
    const finished = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      system,
      "image_requests.finish",
      {
        ...key,
        callId,
        outputMediaId: media.assetId,
        result: { assetId: media.assetId, url, width: pipeline.width, height: pipeline.height },
        costMicrocents: settleImageCostMicrocents(configured.model, requested, generated.usage),
        durationMs: generated.durationMs,
      },
    );
    if (!finished.ok) throw new Error(`settle failed: ${describeError(finished.error)}`);
    return {
      ok: true,
      content: resultText(
        args.operation,
        { assetId: media.assetId, url },
        alt,
        generated.revisedPrompt ? `\n\nProvider revised prompt: ${generated.revisedPrompt}` : "",
      ),
    };
  } catch (e) {
    await execute(toolCtx.registry, toolCtx.adapter, system, "image_requests.mark_uncertain", key);
    return {
      ok: false,
      content: `${tool}: the outcome is uncertain (${(e as Error).message}). The reservation stays charged and the call was not retried. Generate again only if a NEW image is wanted.`,
    };
  }
}
