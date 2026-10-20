// SPDX-License-Identifier: MPL-2.0

/**
 * caelo_upload_images for the stdio shims: reads local files (or base64)
 * and POSTs each image to the admin's `/api/mcp/images`. The per-file loop
 * and the tool definition are shared with the admin's remote endpoint
 * (./surfaces/upload.ts, ./tool-definitions.ts).
 */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolveTimeoutMs } from "./http.js";
import { describeIapRejection, ingressHeaders } from "./ingress-auth.js";
import { type UploadImagesResult, uploadImagesWith } from "./surfaces/upload.js";
import { MAX_IMAGE_BYTES } from "./tool-definitions.js";

/** Read a local image file, refusing anything that is not a 1 B – 5 MiB regular file. */
async function readLocalImage(filePath: string): Promise<Uint8Array> {
  const file = await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_IMAGE_BYTES)
      throw new Error("Expected an image file of 1 byte to 5 MiB");
    // Read at most cap+1 even if the file grows after stat().
    const buffer = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await file.read(buffer, total, buffer.length - total, null);
      if (!bytesRead) break;
      total += bytesRead;
    }
    return buffer.subarray(0, total);
  } finally {
    await file.close();
  }
}

/** Upload caller-selected files, returning failures individually without dropping successes. */
export async function uploadImages(
  opts: { adminUrl: string; token: string },
  input: unknown,
): Promise<UploadImagesResult> {
  return uploadImagesWith(input, {
    readFile: readLocalImage,
    store: async (bytes, meta) => {
      const query = new URLSearchParams({ filename: meta.filename });
      if (meta.alt) query.set("alt", meta.alt);
      if (meta.reference) query.set("visibility", "reference");
      const response = await fetch(`${opts.adminUrl.replace(/\/+$/, "")}/api/mcp/images?${query}`, {
        method: "POST",
        headers: {
          ...(await ingressHeaders()),
          "x-caelo-mcp-token": opts.token,
          "content-type": "application/octet-stream",
        },
        body: new Uint8Array(bytes),
        signal: AbortSignal.timeout(resolveTimeoutMs(120_000)),
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(
          describeIapRejection(response, text) ?? `HTTP ${response.status}: ${text.slice(0, 500)}`,
        );
      }
      const value = (await response.json()) as Record<string, unknown>;
      return { assetId: value.assetId, mime: value.mime };
    },
  });
}
