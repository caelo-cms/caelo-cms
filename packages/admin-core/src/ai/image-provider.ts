// SPDX-License-Identifier: MPL-2.0

import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText } from "ai";

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
 * Two adapters in v1: OpenAI (DALL·E 3) + Gemini (Imagen 3). Both via
 * raw fetch to avoid SDK deps.
 */

export interface ImageRequest {
  readonly prompt: string;
  /** Model id ("dall-e-3", "imagen-3.0-generate-001"). */
  readonly model: string;
  /** Square is the only universally-supported choice; provider-specific
   *  larger sizes are best-effort. Adapters fall back to 1024x1024. */
  readonly size?: "1024x1024" | "1792x1024" | "1024x1792";
  readonly quality?: "standard" | "hd";
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
}

export interface ImageProvider {
  readonly name: "openai" | "google";
  readonly model: string;
  generate(opts: ImageRequest): Promise<ImageResponse>;
}

/**
 * OpenAI DALL·E 3 image adapter.
 */
export class OpenAiImageProvider implements ImageProvider {
  readonly name = "openai" as const;
  readonly model: string;
  readonly #baseUrl: string;
  constructor(opts: { model: string; baseUrl?: string }) {
    this.model = opts.model;
    this.#baseUrl = opts.baseUrl ?? "https://api.openai.com";
  }

  async generate(opts: ImageRequest): Promise<ImageResponse> {
    const start = Date.now();
    const fetchImpl = opts.fetchImpl ?? fetch;
    const res = await fetchImpl(`${this.#baseUrl}/v1/images/generations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${opts.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: opts.model || this.model,
        prompt: opts.prompt,
        size: opts.size ?? "1024x1024",
        quality: opts.quality ?? "standard",
        n: 1,
        response_format: "url",
      }),
      signal: opts.abortSignal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`openai image ${res.status}: ${detail.slice(0, 500)}`);
    }
    const data = (await res.json()) as {
      data: Array<{ url: string; revised_prompt?: string }>;
    };
    const first = data.data?.[0];
    if (!first?.url) throw new Error("openai image: missing url in response");
    return {
      imageUrl: first.url,
      revisedPrompt: first.revised_prompt ?? null,
      durationMs: Date.now() - start,
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
 * Key resolution mirrors the chat: an explicit config apiKey when present,
 * else the SDK reads `GOOGLE_GENERATIVE_AI_API_KEY` from env (the fallback
 * the e2e seed's dummy-encrypted config relies on).
 */
export class GeminiSdkImageProvider implements ImageProvider {
  readonly name = "google" as const;
  readonly model: string;
  constructor(opts: { model: string }) {
    this.model = opts.model;
  }

  async generate(opts: ImageRequest): Promise<ImageResponse> {
    const start = Date.now();
    const hasKey = typeof opts.apiKey === "string" && opts.apiKey.length >= 8;
    const provider = createGoogleGenerativeAI(hasKey ? { apiKey: opts.apiKey } : {});
    const result = await generateText({
      model: provider(opts.model || this.model),
      prompt: opts.prompt,
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
 * Test-only image provider. Returns a deterministic 1×1 PNG as a `data:`
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
