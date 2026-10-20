// SPDX-License-Identifier: MPL-2.0

/**
 * caelo_upload_images, independent of where the bytes come from and go to:
 * the stdio shim reads local files and POSTs to `/api/mcp/images`
 * (../image-upload.ts); the admin's remote endpoint decodes base64 and
 * stores in-process, refusing `filePath` — it cannot read the agent's disk
 * (issue #806). One loop, so both return the same per-file results.
 */

import type { z } from "zod";
import { MAX_IMAGE_BYTES, uploadedImageSchema, uploadImagesInput } from "../tool-definitions.js";

/** What one stored image is described by. */
export interface StoreImageMeta {
  readonly filename: string;
  readonly alt?: string;
  readonly reference?: boolean;
}

export interface UploadImagesDeps {
  /**
   * Read a local file (at most {@link MAX_IMAGE_BYTES} + 1 bytes). Absent on
   * a remote connection: `filePath` is then refused with `filePathRefusal`.
   */
  readonly readFile?: (path: string) => Promise<Uint8Array>;
  /** Why `filePath` is refused when `readFile` is absent. */
  readonly filePathRefusal?: string;
  /** Persist the bytes; returns the stored asset's id and sniffed mime. */
  readonly store: (
    bytes: Uint8Array,
    meta: StoreImageMeta,
  ) => Promise<{ assetId: unknown; mime: unknown }>;
}

/** The tool result: one JSON text block with per-file results (an error only when all failed). */
export interface UploadImagesResult {
  readonly isError?: boolean;
  readonly content: Array<{ type: "text"; text: string }>;
  readonly [key: string]: unknown;
}

/** The base name of a path, on either separator (no node:path in this module). */
function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

/** Upload caller-selected images, returning failures individually without dropping successes. */
export async function uploadImagesWith(
  input: unknown,
  deps: UploadImagesDeps,
): Promise<UploadImagesResult> {
  const parsed = uploadImagesInput.parse(input);
  const results: Array<
    | { index: number; attachment: z.infer<typeof uploadedImageSchema> }
    | { index: number; error: string }
  > = [];
  for (const [index, image] of parsed.images.entries()) {
    try {
      let bytes: Uint8Array;
      if (image.filePath) {
        if (!deps.readFile) {
          throw new Error(
            deps.filePathRefusal ??
              "filePath is not available on this connection — send the image as base64.",
          );
        }
        bytes = await deps.readFile(image.filePath);
      } else {
        if (image.base64 === undefined) throw new Error("Missing image bytes");
        bytes = Buffer.from(image.base64, "base64");
      }
      if (!bytes.length || bytes.length > MAX_IMAGE_BYTES)
        throw new Error("Image must be at most 5 MiB and non-empty");
      const filename = image.filename ?? (image.filePath ? baseName(image.filePath) : "image");
      const stored = await deps.store(bytes, {
        filename,
        ...(image.alt ? { alt: image.alt } : {}),
        ...(image.reference ? { reference: true } : {}),
      });
      const attachment = uploadedImageSchema.parse({
        assetId: stored.assetId,
        mime: stored.mime,
        alt: image.alt ?? filename,
      });
      results.push({ index, attachment });
    } catch (e) {
      results.push({ index, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return {
    ...(results.every((r) => "error" in r) ? { isError: true } : {}),
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          results,
          attachments: results.flatMap((r) => ("attachment" in r ? [r.attachment] : [])),
        }),
      },
    ],
  };
}
