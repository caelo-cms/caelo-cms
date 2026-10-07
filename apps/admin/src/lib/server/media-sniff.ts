// SPDX-License-Identifier: MPL-2.0

import { MEDIA_ALLOWED_MIMES, type MediaMime } from "@caelo-cms/shared";
import { fileTypeFromBuffer } from "file-type";

const ALLOWED_SET = new Set<string>(MEDIA_ALLOWED_MIMES);

/** Outcome of sniffing an upload: the media MIME to store, or null + what was seen. */
export interface SniffedUpload {
  readonly mime: MediaMime | null;
  /** The sniffer's MIME when it recognised the bytes (for the 415 message). */
  readonly sniffedMime: string | null;
}

/**
 * Decide an upload's stored MIME from its BYTES (declared types are
 * user-controlled). file-type returns nothing for SVG (it is text), so
 * the declared type is trusted only when it is `image/svg+xml` AND the
 * body looks like XML. file-type reports cursors (.cur) under the same
 * `image/x-icon` as icons; only a real icon (`ico`) is a media asset, so
 * the stored icon MIME is always the canonical `image/x-icon` whatever
 * name (`image/vnd.microsoft.icon`, …) the browser declared.
 *
 * @param buf the uploaded bytes.
 * @param declaredType the client's `File.type` (consulted for SVG only).
 */
export async function sniffUploadMime(
  buf: Uint8Array,
  declaredType: string,
): Promise<SniffedUpload> {
  const sniffed = await fileTypeFromBuffer(buf);
  if (sniffed) {
    const isCursor = sniffed.mime === "image/x-icon" && sniffed.ext !== "ico";
    return {
      mime: ALLOWED_SET.has(sniffed.mime) && !isCursor ? (sniffed.mime as MediaMime) : null,
      sniffedMime: sniffed.mime,
    };
  }
  if (
    declaredType === "image/svg+xml" &&
    new TextDecoder().decode(buf.subarray(0, 256)).trimStart().startsWith("<")
  ) {
    return { mime: "image/svg+xml", sniffedMime: null };
  }
  return { mime: null, sniffedMime: null };
}
