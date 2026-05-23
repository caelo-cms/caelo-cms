// SPDX-License-Identifier: MPL-2.0

/**
 * v0.12.3 — /content/library/[id] edit view.
 *
 * Fetches one content_instance + its placement list, plus the owning
 * module's fields[] schema so the form renders the right input per
 * field-kind. Save calls content_instances.set_values; on success the
 * page redirects back to the library so the operator sees the updated
 * preview snippet + the propagation toast.
 */

import { execute } from "@caelo-cms/query-api";
import { fail, redirect } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, locals }) => {
  requirePermission(locals, "content.read");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "content_instances.get", {
    id: params.id,
  });
  if (!r.ok) {
    throw redirect(303, "/content/library");
  }
  const { instance, placements } = r.value as {
    instance: {
      id: string;
      moduleId: string;
      moduleSlug: string;
      moduleDisplayName: string;
      slug: string | null;
      displayName: string | null;
      values: Record<string, unknown>;
      version: number;
      placementCount: number;
    };
    placements: {
      pageId: string;
      pageSlug: string;
      pageTitle: string;
      blockName: string;
      position: number;
      syncMode: "synced" | "unsynced";
    }[];
  };

  // Fetch the owning module so the form can render the right input
  // shape per field-kind. The renderer reads `fields` from modules.
  const modR = await execute(registry, adapter, locals.ctx, "modules.get", {
    moduleId: instance.moduleId,
  });
  const moduleFields = modR.ok
    ? ((
        modR.value as {
          module: { fields: { name: string; kind: string; label: string; default?: unknown }[] };
        }
      ).module.fields ?? [])
    : [];

  return { instance, placements, moduleFields };
};

export const actions: Actions = {
  save: async ({ request, params, locals }) => {
    requirePermission(locals, "content.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);

    // Reconstruct the values object from form fields. Each value
    // arrives as `value.<fieldName>` per the input naming in the
    // edit view. Missing fields are dropped (empty form value -> no
    // override → module field default at render time).
    const values: Record<string, unknown> = {};
    for (const [k, v] of form.entries()) {
      if (!k.startsWith("value.")) continue;
      const name = k.slice("value.".length);
      values[name] = typeof v === "string" ? v : "";
    }
    const displayName = form.get("displayName");
    const slug = form.get("slug");

    const r = await execute(registry, adapter, locals.ctx, "content_instances.set_values", {
      id: params.id,
      values,
      ...(typeof displayName === "string" && displayName.length > 0 ? { displayName } : {}),
      ...(typeof slug === "string" && slug.length > 0 ? { slug } : {}),
    });
    if (!r.ok) {
      const msg = (r.error as { message?: string }).message ?? "could not save";
      return fail(400, { error: msg });
    }
    const { placementCount } = r.value as { placementCount: number };
    throw redirect(
      303,
      `/content/library?saved=${encodeURIComponent(params.id)}&placements=${placementCount}`,
    );
  },
};
