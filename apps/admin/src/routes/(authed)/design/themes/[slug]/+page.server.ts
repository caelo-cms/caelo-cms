// SPDX-License-Identifier: MPL-2.0

/**
 * v0.11.1 (issue #76) — `/design/themes/[slug]` edit route.
 *
 * Tabbed shell saves through themes.update_tokens (routine, loose-name
 * patch path) for Colors / Typography / Spacing / Radii / Shadows, and
 * themes.set_asset for the Assets tab. Both ops already emit snapshots
 * in v0.11.0, so the UI inherits chat-keyed Undo without new wiring.
 */

import { execute } from "@caelo-cms/query-api";
import type { Theme } from "@caelo-cms/shared";
import { error, fail } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, locals }) => {
  requirePermission(locals, "roles.manage");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "themes.get", { slug: params.slug });
  if (!r.ok) {
    throw error(500, "themes.get failed");
  }
  const theme = (r.value as { theme: Theme | null }).theme;
  if (!theme) {
    throw error(404, `theme '${params.slug}' not found`);
  }
  return { theme };
};

export const actions: Actions = {
  /**
   * Patch tokens via the loose-name normalizer. Each editor (Colors /
   * Typography / Spacing / Radii / Shadows) posts here with its own
   * loose-name keys; the server canonicalises via normalizeTokens.
   */
  updateTokens: async ({ request, params, locals }) => {
    requirePermission(locals, "roles.manage");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const slug = String(form.get("themeSlug") ?? params.slug);

    // Strip framework keys; everything else is a loose name → value.
    const set: Record<string, string> = {};
    for (const [key, value] of form.entries()) {
      if (key === "_csrf" || key === "themeSlug") continue;
      if (typeof value !== "string") continue;
      if (value.trim().length === 0) continue;
      set[key] = value;
    }
    if (Object.keys(set).length === 0) {
      return fail(400, { error: "nothing to update" });
    }

    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "themes.update_tokens", {
      themeSlug: slug,
      set,
    });
    if (!r.ok) {
      return fail(400, { error: extractErrorMessage(r.error, "update_tokens failed") });
    }
    const v = r.value as { canonicalPathsWritten: string[] };
    return {
      ok: true,
      message: `Saved ${v.canonicalPathsWritten.length} token${v.canonicalPathsWritten.length === 1 ? "" : "s"}.`,
    };
  },

  /**
   * Bind an asset slot to a media row (or clear with mediaId="").
   */
  setAsset: async ({ request, params, locals }) => {
    requirePermission(locals, "roles.manage");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const slug = String(form.get("themeSlug") ?? params.slug);
    const slotRaw = String(form.get("slot") ?? "");
    const validSlots = ["logo", "logoDark", "favicon", "socialShare"] as const;
    if (!(validSlots as readonly string[]).includes(slotRaw)) {
      return fail(400, { error: `invalid slot '${slotRaw}'` });
    }
    const slot = slotRaw as (typeof validSlots)[number];
    const mediaIdRaw = String(form.get("mediaId") ?? "").trim();
    const mediaId = mediaIdRaw.length === 0 ? null : mediaIdRaw;

    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "themes.set_asset", {
      themeSlug: slug,
      slot,
      mediaId,
    });
    if (!r.ok) {
      return fail(400, { error: extractErrorMessage(r.error, "set_asset failed") });
    }
    return {
      ok: true,
      message: mediaId ? `Bound ${slot} to media ${mediaId.slice(0, 8)}…` : `Cleared ${slot}.`,
    };
  },
};

function extractErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return fallback;
}
