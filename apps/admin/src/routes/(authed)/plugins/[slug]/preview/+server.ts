// SPDX-License-Identifier: MPL-2.0

import { runPluginOperation } from "@caelo-cms/plugin-host";
import { error } from "@sveltejs/kit";
import { z } from "zod";
import { requirePermission } from "$lib/server/guards.js";
import { PLUGIN_PREVIEW_CSP, sanitizePluginPreview } from "$lib/server/plugin-preview.js";
import type { RequestHandler } from "./$types";

/** Generic private plugin document, not a published CMS page. */
export const GET: RequestHandler = async ({ params, locals, url }) => {
  requirePermission(locals, "content.write");
  const rawArgs = url.searchParams.get("args") ?? "{}";
  if (rawArgs.length > 2048) throw error(400, "Preview arguments too large");
  let args: unknown;
  try {
    args = JSON.parse(rawArgs);
  } catch {
    throw error(400, "Invalid preview arguments");
  }
  const result = await runPluginOperation({
    pluginSlug: params.slug,
    operationName: "preview",
    args,
    readOnlyPreview: true,
    authorContext: { actor: locals.ctx, operatorActorId: locals.ctx.actorId },
  });
  if (!result.ok) throw error(404, "Preview unavailable");
  const document = z.object({ html: z.string().max(800_000) }).safeParse(result.value);
  if (!document.success) throw error(422, "Invalid plugin preview");
  return new Response(sanitizePluginPreview(document.data.html), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": PLUGIN_PREVIEW_CSP,
      "x-frame-options": "SAMEORIGIN",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
};
