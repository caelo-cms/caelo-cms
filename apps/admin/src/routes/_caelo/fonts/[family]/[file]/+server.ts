// SPDX-License-Identifier: MPL-2.0

/**
 * issue #150 — font resolver route. Serves cached woff2 bytes for the
 * live admin preview iframe, mirroring the /_caelo/media pattern: the
 * static generator copies the same cache files into `_assets/fonts/`
 * at deploy, so production HTML never hits this endpoint.
 *
 * Files are content-addressed (sha16 of the upstream URL, or source
 * sha256 + toolchain tag for registry faces) → immutable cache-control
 * is safe. Path traversal is excluded by the strict
 * slug/file patterns, not by fs checks.
 *
 * Auth: any authenticated user — same stance as the media route.
 */

import { readFile } from "node:fs/promises";
import { error } from "@sveltejs/kit";
import { fontCacheFile } from "#lib/server/preview-sandbox.js";
import { requirePreviewAssetAccess } from "#lib/server/preview-screenshot-auth.js";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, locals, request, cookies }) => {
  // issue #412 — the server-side screenshot browser presents a signed
  // capture token instead of a session; fonts are the same content-
  // addressed bytes either way.
  await requirePreviewAssetAccess(locals, request, cookies);

  const { family, file } = params;
  const path = family && file ? fontCacheFile(family, file) : null;
  if (!path || !file) throw error(404, "not found");

  let body: Uint8Array;
  try {
    body = await readFile(path);
  } catch {
    throw error(404, "font file not cached");
  }

  // Copy into a fresh ArrayBuffer so BodyInit accepts it regardless of
  // the backing buffer kind — same rationale as the media route.
  const mime = `font/${file.split(".").at(-1)}`;
  const copy = new Uint8Array(body.byteLength);
  copy.set(body);
  return new Response(new Blob([copy], { type: mime }), {
    status: 200,
    headers: {
      "content-type": mime,
      "content-length": String(body.byteLength),
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
};
