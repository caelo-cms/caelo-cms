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
    //
    // v0.11.1 (issue #76 Copilot review #2 + #3): some editors post
    // composite tokens (typography.* / shadow.*) as a JSON-encoded
    // string in a single field so the composite shape survives the
    // form-encoding boundary. JSON-parse values that look JSON-shaped
    // (start with `{`, `[`, or a bare number/keyword for fontWeight);
    // fall back to the raw string for scalar fields (colors, hex,
    // CSS lengths, etc.). The downstream normalizer + Zod-validate at
    // themes.update_tokens still catch garbage values.
    const set: Record<string, unknown> = {};
    for (const [key, value] of form.entries()) {
      if (key === "_csrf" || key === "themeSlug") continue;
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (trimmed.length === 0) continue;
      set[key] = coerceFormValue(key, trimmed);
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
   * v0.11.1 (issue #76) — remove a single canonical DTCG path
   * (e.g. `spacing.3xl`). Used by editors that support add/remove
   * UX (SpacingEditor, future TypographyEditor tier removal). The
   * underlying themes.update_tokens op's `remove` parameter takes
   * a list; this action wraps a single-path submission to keep the
   * form shape simple.
   */
  removeToken: async ({ request, params, locals }) => {
    requirePermission(locals, "roles.manage");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const slug = String(form.get("themeSlug") ?? params.slug);
    const path = String(form.get("path") ?? "").trim();
    if (path.length === 0) {
      return fail(400, { error: "remove path is required" });
    }
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "themes.update_tokens", {
      themeSlug: slug,
      remove: [path],
    });
    if (!r.ok) {
      return fail(400, { error: extractErrorMessage(r.error, "remove failed") });
    }
    const v = r.value as { canonicalPathsRemoved: string[] };
    return {
      ok: true,
      message:
        v.canonicalPathsRemoved.length > 0
          ? `Removed ${v.canonicalPathsRemoved.join(", ")}.`
          : `No matching path ('${path}') — already gone.`,
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

/**
 * v0.11.1 (issue #76 Copilot review #2 + #3): convert a raw form-encoded
 * string back into the structured shape the normalizer + Zod schema
 * expect. The form encoding loses type information; this restores it
 * for the two paths that need it:
 *
 *   - composite values (typography.X / shadow.X) — posted as a JSON
 *     object literal, parsed here back to {fontFamily, fontSize, ...}
 *     or {color, offsetX, offsetY, blur, ...} so the canonical Zod
 *     schema's $value-is-object constraint holds.
 *   - typography numerics (typography.X.fontWeight / .lineHeight) —
 *     posted as a bare digit string; parsed to number so the Zod
 *     union `z.number() | z.enum(['normal', 'bold', ...])` accepts it.
 *
 * Everything else (color strings, CSS lengths, named radii, etc.)
 * passes through unchanged.
 */
function coerceFormValue(name: string, raw: string): unknown {
  // JSON-shaped composite or list — try to parse.
  if (raw.startsWith("{") || raw.startsWith("[")) {
    try {
      return JSON.parse(raw);
    } catch {
      // Fall through — the normalizer will reject if it really expected
      // an object; a string value is a perfectly fine fallback.
    }
  }
  // Typography numeric sub-fields: parse as number.
  if (/^typography\.[a-z0-9-]+\.(fontWeight|lineHeight)$/.test(name) && /^\d+(\.\d+)?$/.test(raw)) {
    return Number(raw);
  }
  return raw;
}
