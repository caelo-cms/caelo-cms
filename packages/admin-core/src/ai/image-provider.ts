// SPDX-License-Identifier: MPL-2.0

import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { generateImage, generateText } from "ai";

/**
 * P16 — Image generation provider abstraction.
 *
 * Image generation has fundamentally different shape than text:
 *   - One-shot, not streaming.
 *   - Returns bytes/URLs, not token deltas.
 *   - Per-image pricing, not per-1K-tokens.
 *
 * So it lives in its OWN interface alongside `AIProvider` rather than
 * extending it with a new event kind. The `generate_image` AI tool
 * dispatches to whichever provider's `image_model` field is set on the
 * primary `ai_provider_configs` row.
 *
 * Both providers go through the AI SDK (CLAUDE.md §12): OpenAI image
 * models via `generateImage` (generation, and editing with an optional
 * mask on gpt-image models); Google via Gemini's multimodal `generateText`.
 * Google image and chat models are configured separately. What each model
 * accepts is in image-models.ts; callers check it before a paid call.
 */

export interface ImageRequest {
  readonly prompt: string;
  /** Model id (for example "dall-e-3" or "gemini-3.1-flash-image"). */
  readonly model: string;
  /** Square is the only universally-supported choice; provider-specific
   *  larger sizes are best-effort. Adapters fall back to 1024x1024. */
  readonly size?: "1024x1024" | "1792x1024" | "1024x1792";
  readonly quality?: "standard" | "hd";
  /** Host-resolved bytes only; adapters never fetch caller-provided reference URLs. */
  readonly referenceImages?: readonly {
    data: Uint8Array;
    mediaType: "image/png" | "image/jpeg" | "image/webp";
  }[];
  /** Explicit native Gemini resolution; unsupported models fail before a paid call. */
  readonly imageSize?: "1K" | "2K" | "4K";
  /** #528 — edit this image instead of generating from scratch. */
  readonly editSource?: {
    data: Uint8Array;
    mediaType: "image/png" | "image/jpeg" | "image/webp";
  };
  /** #528 — PNG whose transparent area marks where an edit may change the source. */
  readonly mask?: { data: Uint8Array; mediaType: "image/png" };
  readonly maxOutputTokens?: number;
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly abortSignal?: AbortSignal;
}

export interface ImageResponse {
  /** Provider-hosted ephemeral URL. Caller is expected to download +
   *  persist via media.upload_object before the URL expires. */
  readonly imageUrl: string;
  /** Provider-rewritten prompt (DALL·E does this for safety). NULL when
   *  the provider doesn't expose a revision. */
  readonly revisedPrompt: string | null;
  readonly durationMs: number;
  readonly usage?: { inputTokens: number; outputTokens: number };
}

export interface ImageProvider {
  readonly name: "openai" | "google";
  readonly model: string;
  generate(opts: ImageRequest): Promise<ImageResponse>;
}

/** gpt-image models take their own shapes; DALL·E 3 keeps the classic ones. */
function openAiSize(model: string, size: ImageRequest["size"]): `${number}x${number}` {
  const shape = size ?? "1024x1024";
  if (!model.startsWith("gpt-image")) return shape;
  return shape === "1792x1024" ? "1536x1024" : shape === "1024x1792" ? "1024x1536" : "1024x1024";
}

/**
 * OpenAI image adapter via the AI SDK's `generateImage`. DALL·E 3
 * generates only; gpt-image models also edit (source + references + an
 * optional mask). Bytes come back inline — no provider URL to follow.
 */
export class OpenAiImageProvider implements ImageProvider {
  readonly name = "openai" as const;
  readonly model: string;
  readonly #baseUrl: string | undefined;
  constructor(opts: { model: string; baseUrl?: string }) {
    this.model = opts.model;
    this.#baseUrl = opts.baseUrl;
  }

  async generate(opts: ImageRequest): Promise<ImageResponse> {
    const model = opts.model || this.model;
    if (opts.imageSize) throw new Error("OpenAI image models have no native resolution control");
    const edit = opts.editSource !== undefined;
    if (!edit && (opts.referenceImages?.length || opts.mask))
      throw new Error("OpenAI takes reference images and masks only when editing a source image");
    const start = Date.now();
    const provider = createOpenAI({
      apiKey: opts.apiKey,
      ...(this.#baseUrl ? { baseURL: `${this.#baseUrl.replace(/\/+$/, "")}/v1` } : {}),
      ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
    });
    const quality = model.startsWith("gpt-image")
      ? opts.quality === "hd"
        ? "high"
        : "medium"
      : (opts.quality ?? "standard");
    const result = await generateImage({
      model: provider.image(model),
      prompt: edit
        ? {
            images: [opts.editSource!.data, ...(opts.referenceImages ?? []).map((r) => r.data)],
            text: opts.prompt,
            ...(opts.mask ? { mask: opts.mask.data } : {}),
          }
        : opts.prompt,
      size: openAiSize(model, opts.size),
      providerOptions: { openai: { quality } },
      // Paid call: never retried by the SDK (an uncertain outcome is ours to record).
      maxRetries: 0,
      ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
    });
    const image = result.image;
    return {
      imageUrl: `data:${image.mediaType};base64,${image.base64}`,
      revisedPrompt: null,
      durationMs: Date.now() - start,
      ...(result.usage?.inputTokens !== undefined || result.usage?.outputTokens !== undefined
        ? {
            usage: {
              inputTokens: result.usage.inputTokens ?? 0,
              outputTokens: result.usage.outputTokens ?? 0,
            },
          }
        : {}),
    };
  }
}

/**
 * Google "Nano Banana" image adapter via the Vercel AI SDK's MULTIMODAL
 * `generateText` path (`gemini-2.5-flash-image`, `gemini-3-pro-image`).
 * These models return the image inline in `result.files`, not as a
 * hosted URL — so we hand it back as a `data:` URL and the generate_image
 * tool's existing download → sharp pipeline → media.upload flow is
 * unchanged (`fetch()` reads `data:` URLs). AI-SDK-native (not a raw
 * fetch), so it stays vendor-neutral behind the same provider abstraction
 * as the chat models — no Vercel AI Gateway coupling.
 *
 * The host resolves the encrypted provider key with the chat resolver before
 * invoking this adapter. No credential is read from public provider config.
 */
export class GeminiSdkImageProvider implements ImageProvider {
  readonly name = "google" as const;
  readonly model: string;
  constructor(opts: { model: string }) {
    this.model = opts.model;
  }

  async generate(opts: ImageRequest): Promise<ImageResponse> {
    const model = opts.model || this.model;
    if (opts.mask) throw new Error("Gemini image models cannot limit an edit to a mask");
    // Gemini edits by taking the source image as the first image part.
    const references = [
      ...(opts.editSource ? [opts.editSource] : []),
      ...(opts.referenceImages ?? []),
    ];
    const modernImage = [
      "gemini-3.1-flash-image",
      "gemini-3.1-flash-lite-image",
      "gemini-3-pro-image",
    ].includes(model);
    if (references.length > (modernImage ? 14 : 3))
      throw new Error("Too many reference images for this model");
    if (
      references.some(
        (image) =>
          !(image.data instanceof Uint8Array) ||
          !image.data.byteLength ||
          image.data.byteLength > 10_000_000 ||
          !["image/png", "image/jpeg", "image/webp"].includes(image.mediaType),
      )
    )
      throw new Error("Invalid reference image bytes or media type");
    if (references.reduce((size, image) => size + image.data.byteLength, 0) > 20_000_000)
      throw new Error("Reference images exceed the request byte limit");
    if (opts.imageSize && !modernImage)
      throw new Error("Native resolution is not supported for this configured model");
    const start = Date.now();
    if (!opts.apiKey) throw new Error("gemini image: provider key is not configured");
    const provider = createGoogleGenerativeAI({
      apiKey: opts.apiKey,
      ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
    });
    const result = await generateText({
      model: provider(model),
      messages: [
        {
          role: "user",
          content: [
            ...references.map((image) => ({
              type: "file" as const,
              data: image.data,
              mediaType: image.mediaType,
            })),
            { type: "text", text: opts.prompt },
          ],
        },
      ],
      maxRetries: 0,
      ...(opts.maxOutputTokens ? { maxOutputTokens: opts.maxOutputTokens } : {}),
      providerOptions: {
        google: {
          responseModalities: ["TEXT", "IMAGE"],
          imageConfig: {
            ...(opts.imageSize ? { imageSize: opts.imageSize } : {}),
            aspectRatio:
              opts.size === "1792x1024" ? "16:9" : opts.size === "1024x1792" ? "9:16" : "1:1",
          },
        },
      },
      ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
    });
    const img = result.files.find((f) => f.mediaType.startsWith("image/"));
    if (!img) {
      throw new Error(
        `gemini image: no image in result.files (model '${opts.model || this.model}' may not be image-capable)`,
      );
    }
    return {
      imageUrl: `data:${img.mediaType};base64,${img.base64}`,
      usage: {
        inputTokens: result.usage.inputTokens ?? 0,
        outputTokens: result.usage.outputTokens ?? 0,
      },
      revisedPrompt: null,
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Dispatch helper called by the `generate_image` AI tool. Reads the
 * primary `ai_provider_configs` row + builds the right ImageProvider.
 * Throws when no primary config has `image_model` set.
 */
export function makeImageProvider(opts: {
  kind: "openai" | "google";
  model: string;
  baseUrl?: string;
}): ImageProvider {
  switch (opts.kind) {
    case "openai":
      return new OpenAiImageProvider({ model: opts.model, baseUrl: opts.baseUrl });
    case "google":
      return new GeminiSdkImageProvider({ model: opts.model });
  }
}

/**
 * A valid 16×16 PNG (solid blue) as base64 — produced by sharp, so the
 * media pipeline's sharp decode round-trips cleanly. A hand-rolled 1×1
 * tripped `libpng read error` in vips.
 */
const FAKE_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGUlEQVQokWOIqjhBEmIY1VAxGkpRwzVpAACJzZoQPNqOjQAAAABJRU5ErkJggg==";

/**
 * Test-only image provider. Returns a deterministic 16×16 PNG as a `data:`
 * URL — no HTTP call, no API key, no cost — so e2e can exercise the
 * `generate_image` → media-pipeline → page-reference wiring end to end.
 * `fetch()` handles `data:` URLs, so the download step in the tool is
 * unchanged. Selected only via {@link isFakeImageEnabled}.
 */
export class FakeImageProvider implements ImageProvider {
  readonly name = "openai" as const;
  readonly model = "fake-image";
  async generate(_opts: ImageRequest): Promise<ImageResponse> {
    return { imageUrl: FAKE_PNG_DATA_URL, revisedPrompt: null, durationMs: 0 };
  }
}

/**
 * True when the test-only fake image provider is enabled. Same stance as
 * the AI test-registry (`isTestRegistryEnabled`): honoured ONLY outside
 * production, so a deployed instance can never be coerced into the fake
 * image path. Enabled with `CAELO_FAKE_IMAGE_PROVIDER=1` in the e2e env.
 */
export function isFakeImageEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.CAELO_FAKE_IMAGE_PROVIDER === "1" && env.NODE_ENV !== "production";
}
