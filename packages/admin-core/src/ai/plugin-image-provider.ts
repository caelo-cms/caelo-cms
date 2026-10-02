// SPDX-License-Identifier: MPL-2.0

import type { PluginHostInfra } from "@caelo-cms/plugin-host";
import { execute } from "@caelo-cms/query-api";
import sharp from "sharp";
import { makeImageProvider } from "./image-provider.js";
import { getImageProviderApiKey } from "./provider-resolver.js";

/** Current bounded Google image models. Reserve a conservative upper estimate;
 * actual usage is also estimated conservatively at the image output rate because
 * the SDK's common usage shape combines text and image tokens. Never an invoice.
 * Sources: ai.google.dev/gemini-api/docs/pricing (2026-09-14).
 */
const rates: Record<string, { input: number; output: number; reserve: number }> = {
  "gemini-3.1-flash-image": { input: 0.5, output: 60, reserve: 100_000_000 },
  "gemini-3.1-flash-lite-image": { input: 0.25, output: 30, reserve: 100_000_000 },
  "gemini-3-pro-image": { input: 2, output: 120, reserve: 200_000_000 },
};
export function makePluginImageProvider(
  infra: Pick<PluginHostInfra, "adapter" | "registry">,
): NonNullable<PluginHostInfra["imageProvider"]> {
  const system = {
    actorId: "00000000-0000-0000-0000-00000000ffff",
    actorKind: "system" as const,
    requestId: "plugin-image-config",
  };
  return {
    async describe() {
      const result = await execute(infra.registry, infra.adapter, system, "ai_providers.list", {});
      if (!result.ok) throw new Error("PluginImageConfigurationUnavailable");
      const google = (
        result.value as {
          providers: { name: string; isActive: boolean; config: { imageModel?: string } }[];
        }
      ).providers.find((p) => p.name === "google" && p.isActive);
      const model = google?.config.imageModel;
      if (!model || !rates[model])
        throw new Error("Configure a supported Google image model at /security/ai");
      if (!(await getImageProviderApiKey("google")))
        throw new Error("Configure the Google key at /security/ai");
      return { model, maxCostMicrocents: rates[model].reserve, imageSizes: ["1K", "2K", "4K"] };
    },
    async generate(input) {
      const rate = rates[input.model];
      if (!rate) throw new Error("Unsupported private image model");
      const apiKey = await getImageProviderApiKey("google");
      if (!apiKey) throw new Error("Google image key unavailable");
      const references = [];
      for (const ref of input.references) {
        const source = sharp(ref.data, { limitInputPixels: 40_000_000, animated: false });
        const info = await source.metadata();
        if (!["png", "jpeg", "webp"].includes(info.format ?? "") || (info.pages ?? 1) > 1)
          throw new Error("Invalid image reference");
        references.push({
          data: await source.rotate().toColourspace("srgb").jpeg({ quality: 95 }).toBuffer(),
          mediaType: "image/jpeg" as const,
        });
      }
      const result = await makeImageProvider({ kind: "google", model: input.model }).generate({
        apiKey,
        model: input.model,
        prompt: input.prompt,
        imageSize: input.imageSize,
        referenceImages: references,
        maxOutputTokens: 8192,
        abortSignal: AbortSignal.timeout(180_000),
      });
      // This adapter returns inline bytes. Never follow an arbitrary provider URL here.
      const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(
        result.imageUrl,
      );
      if (!match?.[1] || match[1].length > 28_000_000) throw new Error("Invalid provider image");
      const bytes = Buffer.from(match[1], "base64");
      const output = await sharp(bytes, { limitInputPixels: 40_000_000 })
        .rotate()
        .flatten({ background: "white" })
        .toColourspace("srgb")
        .jpeg({ quality: 85, chromaSubsampling: "4:4:4", mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
      const cost =
        result.usage && result.usage.outputTokens > 0
          ? Math.ceil(
              (result.usage.inputTokens * rate.input + result.usage.outputTokens * rate.output) *
                100,
            )
          : rate.reserve;
      return {
        bytes: output.data,
        width: output.info.width,
        height: output.info.height,
        costMicrocents: cost,
        durationMs: result.durationMs,
      };
    },
  };
}
