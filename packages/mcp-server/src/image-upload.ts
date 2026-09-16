// SPDX-License-Identifier: MPL-2.0

/** Image upload transport shared by chat and admin MCP servers. */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";
import { resolveTimeoutMs } from "./http.js";

const MAX_BYTES = 5 * 1024 * 1024;
/** Uploaded media references accepted by caelo_chat; never accept object-store keys. */
export const uploadedImageSchema = z
  .object({
    assetId: z.string().uuid(),
    mime: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
    alt: z.string().max(2048).optional(),
  })
  .strict();

const imageInput = z
  .object({
    filePath: z.string().min(1).max(4096).optional(),
    base64: z
      .string()
      .min(4)
      .max(Math.ceil(MAX_BYTES / 3) * 4)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
      .optional(),
    filename: z.string().min(1).max(512).optional(),
    alt: z.string().max(2048).optional(),
  })
  .strict()
  .refine(
    (i) => (i.filePath === undefined) !== (i.base64 === undefined),
    "Supply exactly one of filePath or base64",
  );
/** A bounded batch; each file has its own success/error result for safe retries. */
export const uploadImagesInput = z.object({ images: z.array(imageInput).min(1).max(4) }).strict();

/** Exposed in both MCP catalogues, including chat-scoped connections. */
export const UPLOAD_IMAGES_TOOL = {
  name: "caelo_upload_images",
  description:
    "Upload 1–4 PNG, JPEG, WebP or GIF images (5 MiB each) to the Caelo media library. " +
    "Prefer filePath for files on the machine running this MCP server; otherwise supply raw base64 (no data URL). " +
    "Files become shared CMS media assets. Returns attachments for caelo_chat " +
    "or asset IDs for page tools. Uploading does not send a chat message or publish a page. " +
    "Results are per file: retry only failures. Requires the token owner's current content.write permission.",
  inputSchema: {
    type: "object" as const,
    required: ["images"],
    additionalProperties: false,
    properties: {
      images: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            filePath: {
              type: "string",
              description: "Path on the MCP server machine. Mutually exclusive with base64.",
            },
            base64: {
              type: "string",
              description: "Raw image bytes as base64. Mutually exclusive with filePath.",
            },
            filename: { type: "string", description: "Optional media filename." },
            alt: { type: "string", description: "Optional description of the image." },
          },
          oneOf: [{ required: ["filePath"] }, { required: ["base64"] }],
        },
      },
    },
  },
};

/** Upload caller-selected files, returning failures individually without dropping successes. */
export async function uploadImages(opts: { adminUrl: string; token: string }, input: unknown) {
  const parsed = uploadImagesInput.parse(input);
  const results: Array<
    | { index: number; attachment: z.infer<typeof uploadedImageSchema> }
    | { index: number; error: string }
  > = [];
  for (const [index, image] of parsed.images.entries()) {
    try {
      let bytes: Uint8Array;
      if (image.filePath) {
        const file = await open(image.filePath, constants.O_RDONLY | constants.O_NONBLOCK);
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size === 0 || stat.size > MAX_BYTES)
            throw new Error("Expected an image file of 1 byte to 5 MiB");
          // Read at most cap+1 even if the file grows after stat().
          const buffer = Buffer.alloc(MAX_BYTES + 1);
          let total = 0;
          while (total < buffer.length) {
            const { bytesRead } = await file.read(buffer, total, buffer.length - total, null);
            if (!bytesRead) break;
            total += bytesRead;
          }
          bytes = buffer.subarray(0, total);
        } finally {
          await file.close();
        }
      } else {
        if (image.base64 === undefined) throw new Error("Missing image bytes");
        bytes = Buffer.from(image.base64, "base64");
      }
      if (!bytes.length || bytes.length > MAX_BYTES)
        throw new Error("Image must be at most 5 MiB and non-empty");
      const filename = image.filename ?? (image.filePath ? basename(image.filePath) : "image");
      const query = new URLSearchParams({ filename });
      if (image.alt) query.set("alt", image.alt);
      const response = await fetch(`${opts.adminUrl.replace(/\/+$/, "")}/api/mcp/images?${query}`, {
        method: "POST",
        headers: { "x-caelo-mcp-token": opts.token, "content-type": "application/octet-stream" },
        body: new Uint8Array(bytes),
        signal: AbortSignal.timeout(resolveTimeoutMs(120_000)),
      });
      if (!response.ok)
        throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
      const value = (await response.json()) as Record<string, unknown>;
      const attachment = uploadedImageSchema.parse({
        assetId: value.assetId,
        mime: value.mime,
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
