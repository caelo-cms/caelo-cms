// SPDX-License-Identifier: MPL-2.0

/**
 * issue #198 — serve persisted import screenshots to the review UI.
 *
 * Authenticated (settings.write, same gate as the import review
 * surfaces) and NOT under /_caelo/media: these are third-party
 * content captured from someone else's site — they must never be
 * publicly reachable or CDN-cached.
 */

import { getMediaStorage } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { error } from "@sveltejs/kit";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, locals }) => {
  requirePermission(locals, "settings.write");
  const which = params.which;
  if (which !== "source" && which !== "staged") {
    throw error(400, "which must be 'source' or 'staged'");
  }
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "imports.get_page_screenshot_keys", {
    importPageId: params.importPageId,
  });
  if (!r.ok) throw error(404, "import page not found");
  const keys = r.value as {
    screenshotObjectKey: string | null;
    stagedScreenshotObjectKey: string | null;
  };
  const key = which === "source" ? keys.screenshotObjectKey : keys.stagedScreenshotObjectKey;
  if (!key) throw error(404, `no ${which} screenshot stored for this page`);
  let bytes: Uint8Array;
  try {
    bytes = await getMediaStorage().get(key);
  } catch {
    throw error(404, `screenshot object missing from storage (${key})`);
  }
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": "image/png",
      // Review-only content; never let a shared cache keep it.
      "cache-control": "private, max-age=300",
    },
  });
};
