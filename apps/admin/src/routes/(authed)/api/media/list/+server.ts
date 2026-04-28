// SPDX-License-Identifier: MPL-2.0

/**
 * P7 — JSON list endpoint for the MediaPicker dialog. Read-only;
 * permission-gated to `content.read`. Wraps `media.list` for client
 * fetches.
 */

import { execute } from "@caelo/query-api";
import { json } from "@sveltejs/kit";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { RequestHandler } from "./$types";

const ALLOWED_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/gif",
  "image/svg+xml",
  "application/pdf",
  "video/mp4",
]);

export const GET: RequestHandler = async ({ locals, url }) => {
  requirePermission(locals, "content.read");
  const { adapter, registry } = getQueryContext();
  const query = url.searchParams.get("q") ?? undefined;
  const sortRaw = url.searchParams.get("sort");
  const sort = sortRaw === "most_used" ? "most_used" : "recent";
  const mimeRaw = url.searchParams.get("mime");
  const mime = mimeRaw && ALLOWED_MIMES.has(mimeRaw) ? mimeRaw : undefined;
  const limit = Math.min(60, Number(url.searchParams.get("limit") ?? "30"));

  const res = await execute(registry, adapter, locals.ctx, "media.list", {
    query,
    sort,
    mime,
    limit,
    offset: 0,
  });
  if (!res.ok) return json({ assets: [], totalCount: 0 });
  return json(res.value);
};
