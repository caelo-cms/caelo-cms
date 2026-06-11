// SPDX-License-Identifier: MPL-2.0

/**
 * v0.11.1 (issue #76) — `/design/themes` list route.
 *
 * Card-grid view of every theme on the install. Each card shows the
 * primary-color swatch + display name + active badge, with three
 * actions:
 *   - Activate → calls themes.propose_activate (gated; toasts the
 *     approval queue link).
 *   - Clone    → calls themes.duplicate (routine; navigates to the
 *     new theme's edit page).
 *   - Delete   → calls themes.propose_delete (gated; toasts the
 *     approval queue link).
 *
 * Plus a Create action (form action `create`) that submits to
 * themes.propose_create. Since issue #112 there are no presets: the
 * new variant starts from the ACTIVE theme's token document
 * (duplicate-then-tweak — the §1A-consistent flow for a non-technical
 * operator; fully new palettes are composed by the AI in chat), with
 * optional primaryColor (triggers the v0.11.1 OKLCh ramp server-side)
 * and a required description recording the design rationale.
 */

import { execute } from "@caelo-cms/query-api";
import type { Theme } from "@caelo-cms/shared";
import { fail, redirect } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  // roles.manage matches the existing /security/themes/pending permission
  // (theme edits affect every page on the site).
  requirePermission(locals, "roles.manage");
  const { adapter, registry } = getQueryContext();
  const [themesR, pendingR] = await Promise.all([
    execute(registry, adapter, locals.ctx, "themes.list", {}),
    execute(registry, adapter, locals.ctx, "themes.list_pending", {}),
  ]);
  const themes = themesR.ok ? (themesR.value as { themes: Theme[] }).themes : [];
  const pendingCount = pendingR.ok
    ? (pendingR.value as { proposals: unknown[] }).proposals.length
    : 0;
  return { themes, pendingCount };
};

export const actions: Actions = {
  /**
   * Mint a new theme variant. Calls themes.propose_create — the Owner
   * approves at /security/themes/pending to actually create the row.
   */
  create: async ({ request, locals }) => {
    requirePermission(locals, "roles.manage");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const slug = String(form.get("slug") ?? "").trim();
    const displayName = String(form.get("displayName") ?? "").trim();
    const primaryColor = String(form.get("primaryColor") ?? "").trim();
    const description = String(form.get("description") ?? "").trim();

    if (slug.length === 0 || displayName.length === 0 || description.length === 0) {
      return fail(400, { error: "slug, displayName and description are required" });
    }

    const overrides: Record<string, string> = {};
    if (primaryColor.length > 0) overrides.primaryColor = primaryColor;

    const { adapter, registry } = getQueryContext();
    // issue #112 — no presets: the new variant starts from the active
    // theme's full token document. Fail loudly when there is no active
    // theme (CLAUDE.md §2 no-fallbacks): a fresh install always has the
    // seeded active theme, so this only fires on genuinely broken state.
    const activeR = await execute(registry, adapter, locals.ctx, "themes.get_active", {});
    if (!activeR.ok) {
      return fail(400, {
        error: extractErrorMessage(activeR.error, "could not read active theme"),
      });
    }
    const active = (activeR.value as { theme: Theme | null }).theme;
    if (!active) {
      return fail(400, {
        error:
          "no active theme to base the new variant on — activate a theme first (or let the AI compose one in chat).",
      });
    }

    const r = await execute(registry, adapter, locals.ctx, "themes.propose_create", {
      slug,
      displayName,
      description,
      tokens: active.tokens,
      ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
    });
    if (!r.ok) {
      return fail(400, { error: extractErrorMessage(r.error, "create failed") });
    }
    const v = r.value as { proposalId: string };
    return {
      ok: true,
      message: `Proposal queued — click Approve at /security/themes/pending to create theme "${displayName}". Proposal ${v.proposalId.slice(0, 8)}…`,
      pendingPath: "/security/themes/pending",
    };
  },

  /**
   * Propose activating an inactive theme. The execute_proposal flip
   * lands on Owner approval; deploy is a separate gate.
   */
  activate: async ({ request, locals }) => {
    requirePermission(locals, "roles.manage");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const themeId = String(form.get("themeId") ?? "");
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "themes.propose_activate", {
      themeId,
    });
    if (!r.ok) {
      return fail(400, { error: extractErrorMessage(r.error, "activate failed") });
    }
    return {
      ok: true,
      message: "Activation proposal queued. Approve at /security/themes/pending to apply.",
      pendingPath: "/security/themes/pending",
    };
  },

  /**
   * Clone an existing theme into an inactive variant. Routine op
   * (themes.duplicate) — no propose/execute gate, navigation goes
   * directly to the new theme's edit page.
   */
  clone: async ({ request, locals }) => {
    requirePermission(locals, "roles.manage");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const sourceSlug = String(form.get("sourceSlug") ?? "");
    const newSlug = String(form.get("newSlug") ?? "").trim();
    const newDisplayName = String(form.get("newDisplayName") ?? "").trim();
    if (newSlug.length === 0 || newDisplayName.length === 0) {
      return fail(400, { error: "newSlug and newDisplayName are required" });
    }
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "themes.duplicate", {
      sourceSlug,
      newSlug,
      newDisplayName,
    });
    if (!r.ok) {
      return fail(400, { error: extractErrorMessage(r.error, "clone failed") });
    }
    throw redirect(303, `/design/themes/${newSlug}`);
  },

  /**
   * Propose deleting an inactive theme. Owner approves at
   * /security/themes/pending; active themes are rejected by the op.
   */
  delete: async ({ request, locals }) => {
    requirePermission(locals, "roles.manage");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const themeId = String(form.get("themeId") ?? "");
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "themes.propose_delete", {
      themeId,
    });
    if (!r.ok) {
      return fail(400, { error: extractErrorMessage(r.error, "delete failed") });
    }
    return {
      ok: true,
      message: "Delete proposal queued. Approve at /security/themes/pending to apply.",
      pendingPath: "/security/themes/pending",
    };
  },
};

function extractErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return fallback;
}
