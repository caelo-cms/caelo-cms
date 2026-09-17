// SPDX-License-Identifier: MPL-2.0
import { fontReader, fontRef } from "@caelo-cms/font-service";
import { error } from "@sveltejs/kit";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { RequestHandler } from "./$types";
export const GET: RequestHandler = async ({ locals, params, url }) => {
  requirePermission(locals, "roles.manage");
  const parsed = fontRef.safeParse({ id: params.id, sha256: url.searchParams.get("sha256") });
  if (!parsed.success) throw error(400, "Invalid font revision");
  const { adapter } = getQueryContext();
  const { metadata, bytes } = await adapter.withAdminTransaction(locals.ctx, (tx) =>
    fontReader(tx, locals.ctx)(parsed.data),
  );
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": `font/${metadata.format}`,
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
};
