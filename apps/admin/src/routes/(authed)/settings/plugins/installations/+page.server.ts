// SPDX-License-Identifier: MPL-2.0

import { activateApprovedExternalPlugin, pluginManifest } from "@caelo-cms/plugin-host";
import { adminPanelOperations } from "@caelo-cms/plugin-sdk";
import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { requirePermission } from "#lib/server/guards.js";
import { readPluginPackage } from "#lib/server/plugin-package.js";
import { getQueryContext } from "#lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "plugins.install");
  const { adapter, registry } = getQueryContext();
  const result = await execute(registry, adapter, locals.ctx, "plugins.list_installations", {});
  if (!result.ok) throw new Error("Could not load plugin installation reviews");
  const rows = (
    result.value as {
      installations: {
        id: string;
        slug: string;
        artifactDigest: string;
        currentStateDigest: string;
        status: string;
        origin: string;
        manifest: unknown;
        source: string;
        currentManifest: unknown;
        currentStatus: string;
      }[];
    }
  ).installations;
  return {
    installations: rows.map((row) => {
      const manifest = pluginManifest.parse(row.manifest);
      return {
        ...row,
        manifest,
        // The admin pages the Owner approves with this package: who may
        // open each one and which of the plugin's operations it can run.
        panels: (manifest.adminPanels ?? []).map((panel) => ({
          slug: panel.slug,
          title: panel.title,
          description: panel.description,
          permission: panel.permission,
          operations: [...new Set(adminPanelOperations(panel).map((o) => o.operation))],
        })),
      };
    }),
  };
};
function message(error: unknown): string {
  return typeof error === "object" && error && "message" in error
    ? String(error.message)
    : "Installation request failed";
}
export const actions: Actions = {
  stage: async ({ request, locals }) => {
    requirePermission(locals, "plugins.install");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const file = form.get("package");
    if (!(file instanceof File) || file.size > 20_000_000)
      return fail(400, { error: "Choose a plugin package JSON file smaller than 20 MB." });
    let artifact: unknown;
    try {
      artifact = await readPluginPackage(file);
    } catch {
      return fail(400, { error: "Invalid package JSON or compressed package." });
    }
    const { adapter, registry } = getQueryContext();
    const staged = await execute(
      registry,
      adapter,
      locals.ctx,
      "plugins.stage_installation",
      artifact,
    );
    if (!staged.ok) return fail(400, { error: message(staged.error) });
    return {
      ok: true,
      message: "Package submitted. Review its source and requested access below.",
    };
  },
  approve: async ({ request, locals }) => {
    requirePermission(locals, "plugins.install");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const installationId = String(form.get("installationId") ?? "");
    const { adapter, registry } = getQueryContext();
    const approved = await execute(registry, adapter, locals.ctx, "plugins.approve_installation", {
      installationId,
      artifactDigest: form.get("artifactDigest"),
      expectedStateDigest: form.get("expectedStateDigest"),
      capabilities: form.getAll("capability"),
    });
    if (!approved.ok) return fail(409, { error: message(approved.error) });
    const live = await activateApprovedExternalPlugin(installationId);
    if (!live.loaded)
      return fail(409, { error: `Approval recorded; activation did not complete: ${live.reason}` });
    return { ok: true, message: "Approved package is running." };
  },
  retry: async ({ request, locals }) => {
    requirePermission(locals, "plugins.install");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const live = await activateApprovedExternalPlugin(String(form.get("installationId") ?? ""));
    if (!live.loaded) return fail(409, { error: `Activation did not complete: ${live.reason}` });
    return { ok: true, message: "Approved package is running." };
  },
  revoke: async ({ request, locals }) => {
    requirePermission(locals, "plugins.install");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const { adapter, registry } = getQueryContext();
    const revoked = await execute(registry, adapter, locals.ctx, "plugins.revoke_capability", {
      installationId: form.get("installationId"),
      capability: form.get("capability"),
    });
    if (!revoked.ok) return fail(409, { error: message(revoked.error) });
    // The op stops a disabled plugin in the running host after its commit.
    const result = revoked.value as { slug: string; disabled: boolean };
    return {
      ok: true,
      message: result.disabled
        ? "Access revoked. The plugin is disabled; its data is preserved."
        : "Update access revoked. The running version is unchanged.",
    };
  },
};
