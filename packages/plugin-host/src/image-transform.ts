// SPDX-License-Identifier: MPL-2.0
import { createHash } from "node:crypto";
import type { PluginImageTransform, PluginPrivateFiles } from "@caelo-cms/plugin-sdk";
import { z } from "zod";
import type { PluginHostInfra } from "./dispatch.js";

const schema = z
  .object({
    source: z
      .object({ id: z.string().uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict(),
    width: z.number().int().min(1).max(8192),
    height: z.number().int().min(1).max(8192),
    quality: z.number().int().min(60).max(95),
  })
  .strict();
/** A local, bounded image derivative stored through the existing private-file broker.
 * Content-derived identity makes repeated exports reuse bytes; originals are never changed. */
export async function transformPrivateImage(
  files: PluginPrivateFiles,
  infra: PluginHostInfra,
  input: PluginImageTransform,
) {
  const value = schema.parse(input);
  if (!infra.imageTransform) throw new Error("PluginImageTransformUnavailable");
  const meta = await files.stat({ id: value.source.id });
  if (
    meta.status !== "ready" ||
    meta.sha256 !== value.source.sha256 ||
    !["image/jpeg", "image/png", "image/webp"].includes(meta.mediaType)
  )
    throw new Error("PluginImageTransformSourceInvalid");
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < meta.sizeBytes; offset += 262144)
    chunks.push(Buffer.from((await files.readChunk({ id: meta.id, offset })).base64, "base64"));
  const output = await infra.imageTransform({
    bytes: Buffer.concat(chunks),
    width: value.width,
    height: value.height,
    quality: value.quality,
  });
  const sha256 = createHash("sha256").update(output.bytes).digest("hex");
  const hash = createHash("sha256").update(`caelo-image-derivative-v1:${sha256}`).digest("hex");
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  const file = await files.begin({
    id,
    sha256,
    sizeBytes: output.bytes.length,
    mediaType: "image/jpeg",
  });
  if (file.status === "ready") return { file, width: output.width, height: output.height };
  for (let offset = 0; offset < output.bytes.length; offset += 262144)
    await files.writeChunk({
      id,
      offset,
      base64: Buffer.from(output.bytes.subarray(offset, offset + 262144)).toString("base64"),
    });
  return { file: await files.commit({ id }), width: output.width, height: output.height };
}
