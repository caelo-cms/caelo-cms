// SPDX-License-Identifier: MPL-2.0

import { hostInfra, loadedPlugins, makePluginContext } from "@caelo-cms/plugin-host";
import type { PluginContextTier1, PluginFonts, PluginPrivateFiles } from "@caelo-cms/plugin-sdk";
import { error } from "@sveltejs/kit";
import { requirePermission } from "./guards.js";

/** Host selects plugin and author identity; URLs never supply a grant or chat actor. */
export async function privatePluginFiles(
  slug: string,
  locals: App.Locals,
): Promise<PluginPrivateFiles> {
  requirePermission(locals, "content.write");
  const plugin = loadedPlugins.bySlug(slug);
  if (!plugin) throw error(404, "Private file unavailable");
  let ctx: PluginContextTier1;
  try {
    ctx = (await makePluginContext({
      plugin,
      infra: hostInfra(),
      authorContext: { actor: locals.ctx, operatorActorId: locals.ctx.actorId },
    })) as PluginContextTier1;
  } catch {
    throw error(404, "Private file unavailable");
  }
  if (!ctx.privateFiles) throw error(404, "Private file unavailable");
  return ctx.privateFiles;
}

export async function privatePluginFonts(slug: string, locals: App.Locals): Promise<PluginFonts> {
  requirePermission(locals, "content.write");
  const plugin = loadedPlugins.bySlug(slug);
  if (!plugin) throw error(404, "Font unavailable");
  const ctx = (await makePluginContext({
    plugin,
    infra: hostInfra(),
    authorContext: { actor: locals.ctx, operatorActorId: locals.ctx.actorId },
  })) as PluginContextTier1;
  if (!ctx.fonts) throw error(404, "Font access not granted");
  return ctx.fonts;
}
