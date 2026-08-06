// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo-cms/query-api";
import { error, fail } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, params }) => {
  requirePermission(locals, "content.read");
  const { adapter, registry } = getQueryContext();
  const pageR = await execute(registry, adapter, locals.ctx, "pages.get", { pageId: params.id });
  if (!pageR.ok) throw error(404, "page not found");
  const page = (pageR.value as { page: { id: string; slug: string; title: string } }).page;
  const seoR = await execute(registry, adapter, locals.ctx, "pages_seo.get", {
    pageId: params.id,
  });
  const seo = seoR.ok
    ? (
        seoR.value as {
          seo: {
            metaDescription: string;
            ogImageAssetId: string | null;
            canonicalUrl: string | null;
            noindex: boolean;
            changefreq: string;
            priority: number;
            autofilledAt: string | null;
            optimizedAt: string | null;
          } | null;
        }
      ).seo
    : null;

  // Resolve the persisted OG asset id → slug so the preview builds a
  // slug-based media URL. The persisted value stays an id (pages_seo
  // stores the id ref); the slug is display-only.
  let ogImageSlug: string | null = null;
  if (seo?.ogImageAssetId) {
    const ogR = await execute(registry, adapter, locals.ctx, "media.get", {
      assetId: seo.ogImageAssetId,
    });
    if (ogR.ok) {
      ogImageSlug = (ogR.value as { asset: { slug: string } | null }).asset?.slug ?? null;
    }
  }

  return { page, seo, ogImageSlug };
};

export const actions: Actions = {
  save: async ({ request, locals, params }) => {
    requirePermission(locals, "content.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const metaDescription = String(form.get("metaDescription") ?? "");
    const canonicalRaw = String(form.get("canonicalUrl") ?? "");
    const noindex = form.get("noindex") === "on";
    const changefreq = String(form.get("changefreq") ?? "weekly") as
      | "always"
      | "hourly"
      | "daily"
      | "weekly"
      | "monthly"
      | "yearly"
      | "never";
    const priority = Number(form.get("priority") ?? "0.5");
    const ogRaw = String(form.get("ogImageAssetId") ?? "");
    const r = await execute(registry, adapter, locals.ctx, "pages_seo.set", {
      pageId: params.id,
      metaDescription,
      canonicalUrl: canonicalRaw.length === 0 ? null : canonicalRaw,
      noindex,
      changefreq,
      priority,
      ogImageAssetId: ogRaw.length === 0 ? null : ogRaw,
    });
    if (!r.ok) {
      const message =
        typeof r.error === "object" && r.error && "message" in r.error
          ? String((r.error as { message: unknown }).message)
          : "save failed";
      return fail(400, { error: message });
    }
    return { ok: true, message: "Saved." };
  },
};
