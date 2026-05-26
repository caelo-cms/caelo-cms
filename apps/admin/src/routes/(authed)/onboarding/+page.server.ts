// SPDX-License-Identifier: MPL-2.0

/**
 * v0.11.4 (issue #76 follow-up) — onboarding now captures site
 * identity BEFORE the tour steps. Two actions:
 *
 *   `?/identity` — writes siteName + sitePurpose to site_defaults and,
 *                  when a brandColor is supplied, drives a real theme
 *                  update on the active theme (primary token + OKLCh
 *                  ramp + meta.description). Flips theme.origin from
 *                  'seed' to 'operator' because a human is typing
 *                  intent on the form.
 *   `?/complete` — flips the user's onboarded_at flag (unchanged).
 *
 * The identity step is what makes the site theme operator-driven
 * instead of a generic shadcn placeholder. Without it, the chat-runner
 * has no brand context for the AI to use when authoring modules.
 */

import { execute } from "@caelo-cms/query-api";
import { fail, redirect } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  const { adapter, registry } = getQueryContext();
  const defaultsR = await execute(registry, adapter, locals.ctx, "site_defaults.get", {});
  const defaults = defaultsR.ok
    ? (
        defaultsR.value as {
          defaults: { siteName: string | null; sitePurpose: string | null } | null;
        }
      ).defaults
    : null;
  return {
    alreadyOnboarded: locals.user?.onboardedAt !== null,
    siteName: defaults?.siteName ?? "",
    sitePurpose: defaults?.sitePurpose ?? "",
  };
};

export const actions: Actions = {
  identity: async ({ request, locals }) => {
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const siteName = String(form.get("siteName") ?? "").trim();
    const sitePurpose = String(form.get("sitePurpose") ?? "").trim();
    const brandColor = String(form.get("brandColor") ?? "").trim();

    if (!siteName) {
      return fail(400, { error: "Site name is required.", siteName, sitePurpose, brandColor });
    }
    if (siteName.length > 200) {
      return fail(400, {
        error: "Site name is too long (max 200 chars).",
        siteName,
        sitePurpose,
        brandColor,
      });
    }
    if (sitePurpose.length > 2000) {
      return fail(400, {
        error: "Site purpose is too long (max 2000 chars).",
        siteName,
        sitePurpose,
        brandColor,
      });
    }

    // Write identity into site_defaults.
    const identityR = await execute(registry, adapter, locals.ctx, "site_defaults.set_identity", {
      siteName,
      sitePurpose: sitePurpose || null,
    });
    if (!identityR.ok) {
      const e = identityR.error as { message?: string };
      return fail(500, {
        error: e.message ?? "Could not save site identity.",
        siteName,
        sitePurpose,
        brandColor,
      });
    }

    // Update the active theme. The displayName mirrors siteName; the
    // description is the operator's purpose verbatim. These flip the
    // theme's origin to 'operator' via the actor-based handler in
    // themes.update_meta. The seed warning in the chat-runner system
    // prompt disappears on first AI turn after this.
    const metaR = await execute(registry, adapter, locals.ctx, "themes.update_meta", {
      displayName: siteName,
      description: sitePurpose || null,
    });
    if (!metaR.ok) {
      // Identity already saved — surface meta error but don't roll
      // back; the operator can edit the theme directly afterwards.
      const e = metaR.error as { message?: string };
      return fail(500, {
        error: `Identity saved but theme update failed: ${e.message ?? "unknown"}`,
        siteName,
        sitePurpose,
        brandColor,
      });
    }

    // Optional brand color: derive an OKLCh primary ramp from it and
    // write to `color.primary.*` via themes.update_tokens. The op's
    // loose-name normalizer recognizes `primaryColor` → ramp; same
    // entrypoint propose_create_theme uses.
    if (brandColor) {
      if (!/^#[0-9a-fA-F]{3,8}$|^oklch\(.+\)$|^rgb\(.+\)$/i.test(brandColor)) {
        return fail(400, {
          error: "Brand color must be a hex (#rrggbb), oklch(...), or rgb(...) value.",
          siteName,
          sitePurpose,
          brandColor,
        });
      }
      const tokR = await execute(registry, adapter, locals.ctx, "themes.update_tokens", {
        set: { primaryColor: brandColor },
      });
      if (!tokR.ok) {
        const e = tokR.error as { message?: string };
        return fail(500, {
          error: `Identity + meta saved but brand color failed: ${e.message ?? "unknown"}`,
          siteName,
          sitePurpose,
          brandColor,
        });
      }
    }

    return { saved: true, siteName, sitePurpose, brandColor };
  },

  complete: async ({ request, locals }) => {
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const result = await execute(registry, adapter, locals.ctx, "users.complete_onboarding", {});
    if (!result.ok) {
      return fail(500, { error: "Could not complete onboarding." });
    }
    redirect(303, "/");
  },
};
