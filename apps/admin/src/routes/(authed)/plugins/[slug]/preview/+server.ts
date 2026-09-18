// SPDX-License-Identifier: MPL-2.0

import { resolvePrivatePreviewImages } from "@caelo-cms/admin-core";
import { resolvePreviewFonts, runPluginOperation } from "@caelo-cms/plugin-host";
import { pluginPreviewDocumentSchema } from "@caelo-cms/shared";
import { error } from "@sveltejs/kit";
import { requirePermission } from "$lib/server/guards.js";
import { privatePluginFiles, privatePluginFonts } from "$lib/server/plugin-files.js";
import { PLUGIN_PREVIEW_CSP, sanitizePluginPreview } from "$lib/server/plugin-preview.js";
import { previewBridge } from "$lib/server/plugin-preview-bridge.js";
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
  const view = url.searchParams.get("view");
  if (view) {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(view) ||
      !args ||
      typeof args !== "object" ||
      Array.isArray(args)
    )
      throw error(400, "Invalid preview view");
    args = { ...args, previewView: view };
  }
  const result = await runPluginOperation({
    pluginSlug: params.slug,
    operationName: "preview",
    args,
    readOnlyPreview: true,
    authorContext: { actor: locals.ctx, operatorActorId: locals.ctx.actorId },
  });
  if (!result.ok) throw error(404, "Preview unavailable");
  const document = pluginPreviewDocumentSchema.safeParse(result.value);
  if (!document.success) throw error(422, "Invalid plugin preview");
  if (url.searchParams.get("format") === "metadata") {
    const { html: _html, ...metadata } = document.data;
    return Response.json(metadata, {
      headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
    });
  }
  const channel = url.searchParams.get("channel");
  if (channel && !/^[a-f0-9-]{36}$/.test(channel)) throw error(400, "Invalid preview channel");
  let images: ReadonlyMap<string, string>;
  try {
    images = await resolvePrivatePreviewImages(document.data.html, () =>
      privatePluginFiles(params.slug, locals),
    );
  } catch {
    throw error(422, "Private preview images unavailable");
  }
  const html = await resolvePreviewFonts(document.data.html, () =>
    privatePluginFonts(params.slug, locals),
  );
  const targets = new Set(document.data.targets.map((target) => target.id));
  const nonce = crypto.randomUUID();
  const bridge = channel
    ? `<script nonce="${nonce}">${previewBridge(channel, [...targets], document.data.contextTargetIds)}</script>`
    : "";
  const csp = channel
    ? PLUGIN_PREVIEW_CSP.replace("sandbox;", `sandbox allow-scripts; script-src 'nonce-${nonce}';`)
    : PLUGIN_PREVIEW_CSP;
  return new Response(sanitizePluginPreview(html, images, targets) + bridge, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": csp,
      "x-frame-options": "SAMEORIGIN",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
};
