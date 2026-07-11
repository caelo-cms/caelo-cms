// SPDX-License-Identifier: MPL-2.0

/**
 * issue #150 — font resolver route. Serves cached woff2 bytes for the
 * live admin preview iframe, mirroring the /_caelo/media pattern: the
 * static generator copies the same cache files into `_assets/fonts/`
 * at deploy, so production HTML never hits this endpoint.
 *
 * Files are content-addressed (sha16 of the upstream URL) → immutable
 * cache-control is safe. Path traversal is excluded by the strict
 * slug/file patterns, not by fs checks.
 *
 * Auth: any authenticated user — same stance as the media route.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultFontsCacheDir } from "@caelo-cms/admin-core";
import { error } from "@sveltejs/kit";
import { requireUser } from "$lib/server/guards.js";
import type { RequestHandler } from "./$types";

const FAMILY_RE = /^[a-z0-9-]{1,80}$/;
const FILE_RE = /^[a-f0-9]{16}\.woff2$/;

export const GET: RequestHandler = async ({ params, locals }) => {
  requireUser(locals);

  const { family, file } = params;
  if (!family || !file || !FAMILY_RE.test(family) || !FILE_RE.test(file)) {
    throw error(404, "not found");
  }

  let body: Uint8Array;
  try {
    body = await readFile(join(defaultFontsCacheDir(process.cwd()), family, file));
  } catch {
    throw error(404, "font file not cached");
  }

  // Copy into a fresh ArrayBuffer so BodyInit accepts it regardless of
  // the backing buffer kind — same rationale as the media route.
  const copy = new Uint8Array(body.byteLength);
  copy.set(body);
  return new Response(new Blob([copy], { type: "font/woff2" }), {
    status: 200,
    headers: {
      "content-type": "font/woff2",
      "content-length": String(body.byteLength),
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
};
