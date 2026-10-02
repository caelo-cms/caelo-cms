// SPDX-License-Identifier: MPL-2.0

import { getMediaStorage, getMediaStorageProvider, runMediaPipeline } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import {
  CHAT_IMAGE_MIMES,
  CHAT_MAX_ATTACHMENT_BYTES,
  type ExecutionContext,
  MEDIA_ALLOWED_MIMES,
  MEDIA_HARD_LIMIT_BYTES,
  MEDIA_SIZE_CAPS,
  type MediaMime,
} from "@caelo-cms/shared";
import { error } from "@sveltejs/kit";
import { fileTypeFromBuffer } from "file-type";
import { getQueryContext } from "./query.js";

const ALLOWED_SET = new Set<string>(MEDIA_ALLOWED_MIMES);

/** Validate an upload and persist it through the media Query API, attributed to ctx. */
export async function uploadMedia(
  request: Request,
  ctx: ExecutionContext,
  chatImage = false,
  rawImage?: { filename: string; alt?: string },
) {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > MEDIA_HARD_LIMIT_BYTES) {
    throw error(413, `payload too large: max ${MEDIA_HARD_LIMIT_BYTES} bytes`);
  }

  // Count streamed bytes too: Content-Length is optional and untrusted.
  const limit = chatImage ? CHAT_MAX_ATTACHMENT_BYTES + 64 * 1024 : MEDIA_HARD_LIMIT_BYTES;
  const reader = request.body?.getReader();
  if (!reader) throw error(400, "missing upload body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw error(413, "Upload too large. Chat images must be at most 5 MiB.");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let form: FormData;
  try {
    if (rawImage) {
      form = new FormData();
      form.set("file", new File([bytes], rawImage.filename));
      if (rawImage.alt) form.set("alt", rawImage.alt);
    } else {
      form = await new Response(bytes, { headers: request.headers }).formData();
    }
  } catch {
    throw error(400, "expected multipart/form-data with a file field");
  }
  const file = form.get("file");
  const altRaw = form.get("alt");
  const nameRaw = form.get("name");
  if (!(file instanceof File)) {
    throw error(400, "missing 'file' field");
  }
  if (chatImage && file.size > CHAT_MAX_ATTACHMENT_BYTES) {
    throw error(413, "Chat images must be at most 5 MiB.");
  }
  if (file.size === 0) throw error(400, "empty file");
  if (file.size > MEDIA_HARD_LIMIT_BYTES) {
    throw error(413, `payload too large: max ${MEDIA_HARD_LIMIT_BYTES} bytes`);
  }

  const buf = new Uint8Array(await file.arrayBuffer());
  // Sniff MIME server-side (declared types are user-controlled).
  // file-type returns undefined for SVG (it's text); accept the declared
  // type only when it's image/svg+xml AND the body looks like XML.
  const sniffed = await fileTypeFromBuffer(buf);
  let mime: MediaMime | null = null;
  if (sniffed && ALLOWED_SET.has(sniffed.mime)) {
    mime = sniffed.mime as MediaMime;
  } else if (
    !sniffed &&
    file.type === "image/svg+xml" &&
    new TextDecoder().decode(buf.subarray(0, 256)).trimStart().startsWith("<")
  ) {
    mime = "image/svg+xml";
  }
  if (
    !mime ||
    (chatImage && !CHAT_IMAGE_MIMES.includes(mime as (typeof CHAT_IMAGE_MIMES)[number]))
  ) {
    throw error(415, `unsupported media type${sniffed ? `: ${sniffed.mime}` : ""}`);
  }
  if (file.size > MEDIA_SIZE_CAPS[mime]) {
    throw error(413, `payload too large for ${mime}: max ${MEDIA_SIZE_CAPS[mime]} bytes`);
  }

  // SHA-256 via SubtleCrypto.
  const sha = await sha256Hex(buf);

  const { adapter, registry } = getQueryContext();
  const storage = getMediaStorage();

  let result: Awaited<ReturnType<typeof runMediaPipeline>>;
  try {
    result = await runMediaPipeline(sha, mime, buf);
  } catch {
    throw error(422, "The file could not be decoded. Choose a valid, supported image.");
  }

  if (chatImage && (result.variants[0]?.sizeBytes ?? 0) > CHAT_MAX_ATTACHMENT_BYTES) {
    throw error(413, "The decoded image exceeds 5 MiB. Resize the image and upload again.");
  }
  for (const v of result.variants) {
    await storage.put(v.storageKey, v.body, v.contentType);
  }

  const opRes = await execute(registry, adapter, ctx, "media.upload", {
    sha256: sha,
    originalName: file.name.slice(0, 200),
    mime,
    sizeBytes: file.size,
    width: result.width,
    height: result.height,
    alt: typeof altRaw === "string" ? altRaw.slice(0, 2048) : "",
    // Meaningful label → slug. Falls back to the uploaded filename so a
    // plain upload still gets a readable slug; the op does slugify+uniquify.
    name:
      typeof nameRaw === "string" && nameRaw.trim().length > 0
        ? nameRaw.slice(0, 200)
        : file.name.slice(0, 200),
    storageKey: result.variants[0]?.storageKey ?? `${sha}/orig`,
    storageProvider: getMediaStorageProvider(),
    // Media provenance (0181) — a direct operator upload.
    sourceKind: "upload",
    variants: result.variants.map((v) => ({
      variant: v.variant,
      format: v.format,
      width: v.width,
      height: v.height,
      sizeBytes: v.sizeBytes,
      storageKey: v.storageKey,
    })),
  });
  if (!opRes.ok) {
    throw error(500, `media.upload failed: ${describeErr(opRes.error)}`);
  }
  const { assetId, deduped } = opRes.value as { assetId: string; deduped: boolean };
  return { assetId, deduped, mime };
}

async function sha256Hex(body: Uint8Array): Promise<string> {
  // crypto.subtle.digest expects an ArrayBuffer-backed view; copy via
  // ArrayBuffer.slice to avoid the SharedArrayBuffer typing complaint.
  const view = new Uint8Array(body);
  const hash = await crypto.subtle.digest("SHA-256", view.buffer.slice(0));
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function describeErr(e: unknown): string {
  if (typeof e === "object" && e !== null && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return JSON.stringify(e);
}
