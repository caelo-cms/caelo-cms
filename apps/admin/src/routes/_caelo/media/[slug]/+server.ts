// SPDX-License-Identifier: MPL-2.0

/**
 * Media resolver — ORIG variant by SLUG. Serves the flat, meaningful
 * media URL `/_caelo/media/<slug>` (e.g. `/_caelo/media/searchviu-logo`)
 * that module HTML + the media UI now emit for the original asset. Named
 * variants (srcset webp, focal crops) nest one segment deeper and are
 * served by the sibling `[slug]/[variant]` route.
 *
 * `media.get` resolves EITHER a UUID id or a slug, so `params.slug` is
 * passed straight through — a legacy `/_caelo/media/<uuid>` still lands
 * here and resolves by id.
 *
 * Auth + caching mirror the variant route: any authenticated user;
 * content is content-addressed so the bytes are safe to cache long +
 * immutable. The static generator rewrites these URLs at deploy time, so
 * production HTML never hits this endpoint.
 */

import { getMediaStorage } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { error } from "@sveltejs/kit";
import { requireUser } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, locals }) => {
  requireUser(locals);

  const { slug } = params;
  if (!slug) throw error(404, "not found");

  const { adapter, registry } = getQueryContext();
  const res = await execute(registry, adapter, locals.ctx, "media.get", { assetId: slug });
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

  const v = asset.variants.find((x) => x.variant === "orig");
  if (!v) throw error(404, "orig variant not emitted for this asset");

  const storage = getMediaStorage();
  let body: Uint8Array;
  try {
    body = await storage.get(v.storageKey);
  } catch {
    throw error(404, "storage object missing");
  }

  // Copy into a fresh ArrayBuffer so BodyInit accepts it regardless of the
  // backing buffer kind (see the variant route for the same guard).
  const copy = new Uint8Array(body.byteLength);
  copy.set(body);
  const contentType = contentTypeFor(v.format);
  return new Response(new Blob([copy], { type: contentType }), {
    status: 200,
    headers: {
      "content-type": contentType,
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
