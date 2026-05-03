// SPDX-License-Identifier: MPL-2.0

/**
 * P7 — media resolver. Serves asset bytes by (assetId, variant) for
 * the live admin preview iframe. The static generator's media-pass
 * rewrites these URLs to `/_assets/...` at deploy time, so this
 * endpoint is admin-only — production HTML never hits it.
 *
 * Serves with a long cache-control because content is content-
 * addressed (the assetId points at a sha-keyed storage object;
 * re-uploading the same content yields the same id).
 *
 * Auth: any authenticated user. We don't permission-gate beyond
 * "logged in" — public-site visitors render against the static
 * output, never this endpoint.
 */

import { getMediaStorage } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { MEDIA_VARIANT_TAGS, type MediaVariantTag } from "@caelo-cms/shared";
import { error } from "@sveltejs/kit";
import { requireUser } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { RequestHandler } from "./$types";

const VALID_VARIANTS = new Set<string>(MEDIA_VARIANT_TAGS);

export const GET: RequestHandler = async ({ params, locals }) => {
  requireUser(locals);

  const { assetId, variant } = params;
  if (!assetId || !variant || !VALID_VARIANTS.has(variant)) {
    throw error(404, "not found");
  }

  const { adapter, registry } = getQueryContext();
  const res = await execute(registry, adapter, locals.ctx, "media.get", { assetId });
  if (!res.ok) throw error(404, "not found");
  const asset = (
    res.value as {
      asset: {
        mime: string;
        variants: { variant: string; storageKey: string; format: string }[];
      } | null;
    }
  ).asset;
  if (!asset) throw error(404, "not found");

  const v = asset.variants.find((x) => x.variant === (variant as MediaVariantTag));
  if (!v) throw error(404, `variant '${variant}' not emitted for this asset`);

  const storage = getMediaStorage();
  let body: Uint8Array;
  try {
    body = await storage.get(v.storageKey);
  } catch {
    throw error(404, "storage object missing");
  }

  // Content-addressed → safe for long caching. Etag = sha is implicit
  // via the assetId (which is keyed by sha in the upload pipeline).
  // Copy into a fresh ArrayBuffer so BodyInit accepts it regardless of
  // the backing buffer kind (Bun's Uint8Array can carry a non-strict
  // ArrayBufferLike). new Uint8Array(len) gives an exact ArrayBuffer.
  const copy = new Uint8Array(body.byteLength);
  copy.set(body);
  return new Response(new Blob([copy], { type: contentTypeFor(v.format) }), {
    status: 200,
    headers: {
      "content-type": contentTypeFor(v.format),
      "content-length": String(body.byteLength),
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
};

function contentTypeFor(format: string): string {
  switch (format) {
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "avif":
      return "image/avif";
    case "gif":
      return "image/gif";
    case "svg":
      return "image/svg+xml";
    case "pdf":
      return "application/pdf";
    case "mp4":
      return "video/mp4";
    default:
      return "application/octet-stream";
  }
}
