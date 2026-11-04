// SPDX-License-Identifier: MPL-2.0
import { hostInfra, loadedPlugins, makePluginContext } from "@caelo-cms/plugin-host";
import { error } from "@sveltejs/kit";
import { requirePermission } from "./guards.js";
/** Host selects plugin and author identity; URLs never supply a grant or chat actor. */
export async function privatePluginFiles(slug, locals) {
    requirePermission(locals, "content.write");
    const plugin = loadedPlugins.bySlug(slug);
    if (!plugin)
        throw error(404, "Private file unavailable");
    let ctx;
    try {
        ctx = (await makePluginContext({
            plugin,
            infra: hostInfra(),
            // The panel author reading their plugin's files (main; files have no branch).
            invocation: { origin: "owner-panel", actorId: locals.ctx.actorId },
        }));
    }
    catch {
        throw error(404, "Private file unavailable");
    }
    if (!ctx.privateFiles)
        throw error(404, "Private file unavailable");
    return ctx.privateFiles;
}
export async function privatePluginFonts(slug, locals) {
    requirePermission(locals, "content.write");
    const plugin = loadedPlugins.bySlug(slug);
    if (!plugin)
        throw error(404, "Font unavailable");
    let ctx;
    try {
        ctx = (await makePluginContext({
            plugin,
            infra: hostInfra(),
            // The panel author previewing their plugin; the font library is shared.
            invocation: { origin: "owner-panel", actorId: locals.ctx.actorId },
        }));
    }
    catch {
        throw error(404, "Font unavailable");
    }
    if (!ctx.fonts)
        throw error(404, "Font access not granted");
    return ctx.fonts;
}
