// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo-cms/query-api";
import {
  MAX_IMAGE_PREVIEW_VALUES,
  type MaxImagePreview,
  SEO_TEXT_FIELDS,
  type SeoAuthorship,
  type SeoTextField,
  type SeoValueOrigin,
} from "@caelo-cms/shared";
import { error, fail } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

/** The page's stored SEO as the panel edits it. */
interface SeoRow {
  seoTitle: string;
  metaDescription: string;
  ogTitle: string;
  ogDescription: string;
  ogImageAssetId: string | null;
  canonicalUrl: string | null;
  noindex: boolean;
  nofollow: boolean;
  noarchive: boolean;
  nosnippet: boolean;
  noimageindex: boolean;
  maxSnippet: number | null;
  maxImagePreview: MaxImagePreview;
  maxVideoPreview: number | null;
  origins: Partial<Record<SeoTextField, SeoAuthorship>>;
  changefreq: string;
  priority: number;
  autofilledAt: string | null;
  optimizedAt: string | null;
}

/** #1752 — a value as a build renders it, with where it comes from. */
interface ResolvedValue {
  value: string;
  origin: SeoValueOrigin;
  template?: string | null;
  inheritsFrom?: string | null;
}

interface ResolvedHead {
  title: ResolvedValue;
  metaDescription: ResolvedValue;
  ogTitle: ResolvedValue;
  ogDescription: ResolvedValue;
  ogType: ResolvedValue;
  robots: string;
  pageType: string;
}

export const load: PageServerLoad = async ({ locals, params }) => {
  requirePermission(locals, "content.read");
  const { adapter, registry } = getQueryContext();
  const pageR = await execute(registry, adapter, locals.ctx, "pages.get", { pageId: params.id });
  if (!pageR.ok) throw error(404, "page not found");
  const page = (pageR.value as { page: { id: string; slug: string; title: string } }).page;
  const seoR = await execute(registry, adapter, locals.ctx, "pages_seo.get", {
    pageId: params.id,
  });
  if (!seoR.ok) throw error(500, "the page's SEO could not be read — reload to try again");
  const { seo, resolved } = seoR.value as { seo: SeoRow | null; resolved: ResolvedHead | null };

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

  // #1452 — what the page shows while it has no image of its own.
  const shareR = await execute(registry, adapter, locals.ctx, "pages_seo.share_images", {
    pageIds: [params.id],
  });
  const shareImage = shareR.ok
    ? ((
        shareR.value as {
          images: { source: "page" | "language" | "site" | "none"; url: string | null }[];
        }
      ).images[0] ?? null)
    : null;

  return { page, seo, resolved, ogImageSlug, shareImage };
};

/** A preview limit field: empty = no directive, else an integer from -1. */
function limitOf(raw: FormDataEntryValue | null): number | null {
  const v = String(raw ?? "").trim();
  return v.length === 0 ? null : Number(v);
}

export const actions: Actions = {
  save: async ({ request, locals, params }) => {
    requirePermission(locals, "content.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const text = (name: string): string => String(form.get(name) ?? "");
    const canonicalRaw = text("canonicalUrl");
    const changefreq = String(form.get("changefreq") ?? "weekly") as
      | "always"
      | "hourly"
      | "daily"
      | "weekly"
      | "monthly"
      | "yearly"
      | "never";
    const priority = Number(form.get("priority") ?? "0.5");
    const ogRaw = text("ogImageAssetId");
    const maxImagePreview = text("maxImagePreview") as MaxImagePreview;
    if (!MAX_IMAGE_PREVIEW_VALUES.includes(maxImagePreview)) {
      return fail(400, { error: "Choose how large an image preview may be." });
    }
    const reviewed = form
      .getAll("reviewed")
      .map(String)
      .filter((f): f is SeoTextField => (SEO_TEXT_FIELDS as readonly string[]).includes(f));
    const r = await execute(registry, adapter, locals.ctx, "pages_seo.set", {
      pageId: params.id,
      seoTitle: text("seoTitle"),
      metaDescription: text("metaDescription"),
      ogTitle: text("ogTitle"),
      ogDescription: text("ogDescription"),
      canonicalUrl: canonicalRaw.length === 0 ? null : canonicalRaw,
      noindex: form.get("noindex") === "on",
      nofollow: form.get("nofollow") === "on",
      noarchive: form.get("noarchive") === "on",
      nosnippet: form.get("nosnippet") === "on",
      noimageindex: form.get("noimageindex") === "on",
      maxSnippet: limitOf(form.get("maxSnippet")),
      maxImagePreview,
      maxVideoPreview: limitOf(form.get("maxVideoPreview")),
      changefreq,
      priority,
      ogImageAssetId: ogRaw.length === 0 ? null : ogRaw,
      ...(reviewed.length > 0 ? { reviewed } : {}),
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
