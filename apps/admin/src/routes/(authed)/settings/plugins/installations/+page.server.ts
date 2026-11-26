// SPDX-License-Identifier: MPL-2.0

import { activateApprovedExternalPlugin, pluginManifest } from "@caelo-cms/plugin-host";
import {
  adminPanelOperations,
  externalCapabilityRefusal,
  externalUrlSlotRefusal,
} from "@caelo-cms/plugin-sdk";
import {
  describePluginOperations,
  execute,
  pluginOperationAllowlistRefusal,
} from "@caelo-cms/query-api";
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
        // #1729 — requested access no runtime-installed plugin can be granted
        // yet: approval would be refused, so the page says why instead of
        // offering it.
        unavailable: [
          ...(manifest.requestedCapabilities ?? []).map((capability) =>
            externalCapabilityRefusal(capability),
          ),
          // A URL slot no runtime-installed plugin can claim (Q7 A).
          ...(manifest.urlContributions ?? []).map((claim) =>
            externalUrlSlotRefusal(claim.slot, manifest.urlTables !== undefined),
          ),
          // An allowlist naming an operation no plugin can call is refused
          // at approval too; a package staged before that check says so here.
          (manifest.requestedCapabilities ?? []).includes("cms_admin")
            ? pluginOperationAllowlistRefusal(
                registry,
                manifest.capabilityConstraints?.cms_admin?.operations ?? [],
              )
            : null,
        ].filter((refusal): refusal is string => refusal !== null),
        // #1729 — the core operations a cms_admin grant lets the plugin
        // call, by domain and by read or write (decision Q9), from the
        // markers of the operations this admin runs.
        cmsOperations: (manifest.requestedCapabilities ?? []).includes("cms_admin")
          ? describePluginOperations(
              registry,
              manifest.capabilityConstraints?.cms_admin?.operations ?? [],
            )
          : null,
        // The admin pages the Owner approves with this package: who may
        // open each one and which of the plugin's operations it can run.
        panels: (manifest.adminPanels ?? []).map((panel) => ({
          slug: panel.slug,
          title: panel.title,
          description: panel.description,
          permission: panel.permission,
          operations: [...new Set(adminPanelOperations(panel).map((o) => o.operation))],
        })),
        // #1729 (Q8 A) — the daily AI spending the Owner approves with this
        // exact package, in dollars; the ledger holds the plugin to it.
        aiDailyCapUsd: dollars(manifest.capabilityConstraints?.ai_provider?.maxDailyCostMicrocents),
        // #1729 — every mail the plugin can send, as its recipient reads it.
        mails: Object.entries(manifest.mailTemplates ?? {}).map(([name, t]) => ({
          name,
          subject: t.subject,
          body: t.body,
          linkLabel: t.link?.label ?? null,
        })),
        // The editor toolbar items, with the text their "ask the AI"
        // buttons put into the chat composer.
        toolbarItems: (manifest.editorToolbar ?? []).map((item) => ({
          id: item.id,
          title: item.title,
          permission: item.permission,
          operation: item.operation,
          prompts: (item.prompts ?? []).map((p) => ({ label: p.label, text: p.text })),
        })),
      };
    }),
  };
};
/** Microcents as dollars; below a cent with four decimals, so a small cap does not read "$0.00". */
function dollars(microcents: number | undefined): string | null {
  if (microcents === undefined) return null;
  return (microcents / 1e8).toFixed(microcents < 1_000_000 ? 4 : 2);
}
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
