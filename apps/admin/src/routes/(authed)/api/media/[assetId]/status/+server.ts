// SPDX-License-Identifier: MPL-2.0

/**
 * P7 optimization #4 — processing-status read endpoint backing the
 * detail page's progress skeleton. Polled while
 * `processing_status='processing'`. JSON shape:
 *
 *   { status: 'processing'|'ready'|'failed', error?: string, processedAt?: string }
 *
 * Auth: `content.read` — same gate as the rest of the media surface.
 */

import { execute } from "@caelo/query-api";
import { json } from "@sveltejs/kit";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals, params }) => {
  requirePermission(locals, "content.read");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "media.get_processing_status", {
    assetId: params.assetId,
  });
  if (!r.ok) {
    return json({ status: "failed", error: "asset not found" }, { status: 404 });
  }
  return json(r.value);
};
