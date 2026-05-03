// SPDX-License-Identifier: MPL-2.0

/**
 * P11 — Owner observability + activation surface for plugins.
 * Tier 1 (core, signed) and Tier 2 (AI-authored, sandboxed) listed
 * separately; Approve / Disable / Reject / Re-enable / Reapprove
 * actions per row. Activate orchestrates prepare → provision → commit
 * with a public-schema rollback on commit failure.
 */

import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

interface PluginRow {
  id: string;
  slug: string;
  version: string;
  tier: 1 | 2;
  status: "draft" | "awaiting_activation" | "active" | "disabled" | "rejected" | "failed";
  manifestJson: unknown;
  sourceCode: string | null;
  sourcePath: string | null;
  validationErrors: Array<{
    kind: string;
    nodeType?: string;
    snippet?: string;
    location?: { line: number; column: number };
    hint: string;
  }>;
  manifestSignature: string | null;
  submittedBy: string;
  activatedBy: string | null;
  activatedAt: string | null;
  disabledBy: string | null;
  disabledAt: string | null;
  rejectedBy: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "settings.write");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "plugins.list", {});
  const plugins = r.ok ? (r.value as { plugins: PluginRow[] }).plugins : [];
  const tier1 = plugins.filter((p) => p.tier === 1);
  const tier2Active = plugins.filter((p) => p.tier === 2 && p.status === "active");
  const tier2AwaitingActivation = plugins.filter(
    (p) => p.tier === 2 && p.status === "awaiting_activation",
  );
  const tier2Failed = plugins.filter(
    (p) => p.tier === 2 && (p.status === "draft" || p.status === "failed"),
  );
  const tier2Disabled = plugins.filter((p) => p.tier === 2 && p.status === "disabled");
  const tier2Rejected = plugins.filter((p) => p.tier === 2 && p.status === "rejected");
  return {
    tier1,
    tier2Active,
    tier2AwaitingActivation,
    tier2Failed,
    tier2Disabled,
    tier2Rejected,
  };
};

export const actions: Actions = {
  activate: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    const slug = form.get("slug");
    if (typeof slug !== "string" || !slug) return fail(400, { error: "slug required" });
    const { adapter, registry } = getQueryContext();

    // Step 1 — prepare: validate state + emit DDL (or signal re-enable).
    const prep = await execute(registry, adapter, locals.ctx, "plugins.prepare_activation", {
      slug,
    });
    if (!prep.ok) {
      return fail(400, { error: `prepare failed: ${prep.error.kind}` });
    }
    const prepared = prep.value as {
      pluginId: string;
      version: string;
      schemaName: string;
      appliedSql: string;
      isReEnable: boolean;
    };

    // Step 2 — provision the cms_public schema (skip on re-enable).
    if (!prepared.isReEnable) {
      try {
        await adapter.provisionPluginPublicSchema({
          pluginId: prepared.pluginId,
          sql: prepared.appliedSql,
        });
      } catch (e) {
        return fail(500, {
          error: `cms_public provisioning failed: ${(e as Error).message}`,
        });
      }
    }

    // Step 3 — commit: record migration row + flip status + create
    // per-plugin actor row. On commit failure, drop the public schema
    // we just created so cms_public doesn't leak.
    const commit = await execute(registry, adapter, locals.ctx, "plugins.activate", {
      slug,
      schemaName: prepared.isReEnable ? undefined : prepared.schemaName,
      appliedSql: prepared.isReEnable ? undefined : prepared.appliedSql,
      version: prepared.isReEnable ? undefined : prepared.version,
    });
    if (!commit.ok) {
      if (!prepared.isReEnable) {
        try {
          await adapter.dropPluginPublicSchema({ schemaName: prepared.schemaName });
        } catch (rollbackError) {
          return fail(500, {
            error: `commit failed (${commit.error.kind}); ALSO rollback failed: ${(rollbackError as Error).message}. Manual cleanup needed for cms_public schema "${prepared.schemaName}".`,
          });
        }
      }
      return fail(400, { error: `commit failed: ${commit.error.kind}` });
    }
    return { ok: true, message: `Activated ${slug}.` };
  },
  disable: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    const slug = form.get("slug");
    if (typeof slug !== "string" || !slug) return fail(400, { error: "slug required" });
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "plugins.disable", { slug });
    if (!r.ok) return fail(400, { error: r.error.kind });
    return { ok: true, message: `Disabled ${slug}.` };
  },
  reject: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    const slug = form.get("slug");
    const reason = form.get("reason");
    if (typeof slug !== "string" || !slug) return fail(400, { error: "slug required" });
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "plugins.reject", {
      slug,
      reason: typeof reason === "string" ? reason : undefined,
    });
    if (!r.ok) return fail(400, { error: r.error.kind });
    return { ok: true, message: `Rejected ${slug}.` };
  },
  revalidate: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    const slug = form.get("slug");
    if (typeof slug !== "string" || !slug) return fail(400, { error: "slug required" });
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "plugins.revalidate", { slug });
    if (!r.ok) return fail(400, { error: r.error.kind });
    return { ok: true, message: `Revalidated ${slug}.` };
  },
};
