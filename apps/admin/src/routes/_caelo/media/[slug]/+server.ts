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
import { mediaFormatContentType, mediaSecurityHeaders } from "@caelo-cms/shared";
import { error } from "@sveltejs/kit";
import { requirePreviewAssetAccess } from "#lib/server/preview-screenshot-auth.js";
import { getQueryContext } from "#lib/server/query.js";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, locals, request, cookies }) => {
  // issue #412 — the server-side screenshot browser presents a signed
  // capture token instead of a session; same read grant either way.
  const ctx = await requirePreviewAssetAccess(locals, request, cookies);

  const { slug } = params;
  if (!slug) throw error(404, "not found");

  const { adapter, registry } = getQueryContext();
  const res = await execute(registry, adapter, ctx, "media.get", { assetId: slug });
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

  // #1216 — streamed, never read whole (see the variant route).
  let file: { body: ReadableStream<Uint8Array>; sizeBytes: number };
  try {
    file = await getMediaStorage().openStream(v.storageKey);
  } catch {
    throw error(404, "storage object missing");
  }

  const contentType = mediaFormatContentType(v.format);
  return new Response(file.body, {
    status: 200,
    headers: {
      "content-type": contentType,
      "content-length": String(file.sizeBytes),
      "cache-control": "private, max-age=31536000, immutable",
      ...mediaSecurityHeaders(contentType),
    },
  });
};
