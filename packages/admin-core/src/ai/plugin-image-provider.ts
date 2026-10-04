// SPDX-License-Identifier: MPL-2.0

import type { PluginHostInfra } from "@caelo-cms/plugin-host";
import { execute } from "@caelo-cms/query-api";
import sharp from "sharp";
import {
  imageCapabilities,
  imageReserveMicrocents,
  SUPPORTED_IMAGE_MODELS,
  settleImageCostMicrocents,
} from "./image-models.js";
import { makeImageProvider } from "./image-provider.js";
import { getImageProviderApiKey } from "./provider-resolver.js";

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
      // Plugin images are Google-only and need native resolutions (#521).
      const capabilities = model ? imageCapabilities(model) : null;
      const reserve = model ? imageReserveMicrocents(model) : null;
      if (!model || !capabilities || reserve === null || capabilities.imageSizes.length === 0)
        throw new Error(
          `Configure a supported Google image model at /security/ai (${SUPPORTED_IMAGE_MODELS.filter((m) => m.startsWith("gemini-")).join(", ")})`,
        );
      if (!(await getImageProviderApiKey("google")))
        throw new Error("Configure the Google key at /security/ai");
      return {
        model,
        maxCostMicrocents: reserve,
        imageSizes: capabilities.imageSizes,
        capabilities,
      };
    },
    async generate(input) {
      if (!imageCapabilities(input.model)) throw new Error("Unsupported private image model");
      const apiKey = await getImageProviderApiKey("google");
      if (!apiKey) throw new Error("Google image key unavailable");
      // Normalise every source image the same way (sRGB JPEG, rotation
      // applied); the edit source travels first and keeps its role.
      const normalise = async (data: Uint8Array) => {
        const source = sharp(data, { limitInputPixels: 40_000_000, animated: false });
        const info = await source.metadata();
        if (!["png", "jpeg", "webp"].includes(info.format ?? "") || (info.pages ?? 1) > 1)
          throw new Error("Invalid image reference");
        return {
          data: await source.rotate().toColourspace("srgb").jpeg({ quality: 95 }).toBuffer(),
          mediaType: "image/jpeg" as const,
        };
      };
      const editSource = input.editSource ? await normalise(input.editSource.data) : undefined;
      const references = [];
      for (const ref of input.references) references.push(await normalise(ref.data));
      const result = await makeImageProvider({ kind: "google", model: input.model }).generate({
        apiKey,
        model: input.model,
        prompt: input.prompt,
        imageSize: input.imageSize,
        referenceImages: references,
        ...(editSource ? { editSource } : {}),
        ...(input.mask ? { mask: input.mask } : {}),
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
      const cost = settleImageCostMicrocents(input.model, {}, result.usage);
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
