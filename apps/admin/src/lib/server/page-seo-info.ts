// SPDX-License-Identifier: MPL-2.0

/**
 * #1156 — what the editor's SEO info shows for the page in the preview:
 * the values a search result and a social share take from the page, as
 * this chat's draft has them, and which of them are pending (changed in
 * the draft, live only after a Stage and a Publish live). None of these
 * is visible in the rendered preview, so the editor shows them on demand.
 *
 * #1752 — each value as a build renders it (`pages_seo.get`'s `resolved`:
 * the page's own text, its page type's or the site's template, or shared
 * from another field) with where it comes from.
 */

import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext, SeoValueOrigin, ShareImageSource } from "@caelo-cms/shared";
import { getQueryContext } from "./query.js";

/** A head value and where it comes from (`resolvePageSeoHead`). */
export interface SeoInfoValue {
  readonly value: string;
  readonly origin: SeoValueOrigin;
  /** The template it was filled from (`page_type` / `site` titles). */
  readonly template?: string | null;
  /** The field it is shared from (`inherited` values). */
  readonly inheritsFrom?: string | null;
}

/** One page's SEO as the editor shows it. */
export interface PageSeoInfo {
  readonly title: SeoInfoValue;
  readonly metaDescription: SeoInfoValue;
  readonly ogTitle: SeoInfoValue;
  readonly ogDescription: SeoInfoValue;
  readonly ogType: SeoInfoValue;
  /** The `<meta name="robots">` content. */
  readonly robots: string;
  /** The page type the templates come from. */
  readonly pageType: string;
  /** The image the page really gets (#1452); null with a source = deleted asset. */
  readonly ogImageUrl: string | null;
  /** Where that image comes from: the page, its language, the site, or nowhere. */
  readonly ogImageSource: ShareImageSource;
  readonly canonicalUrl: string | null;
  readonly noindex: boolean;
  /** Pending fields: `title` plus the SEO fields the draft changed. */
  readonly pending: readonly string[];
  /** The page itself was created in the draft: nothing of it is live yet. */
  readonly newPage: boolean;
}

interface SeoRow {
  canonicalUrl: string | null;
  noindex: boolean;
  pendingFields: string[];
}

interface ResolvedHead {
  title: SeoInfoValue;
  metaDescription: SeoInfoValue;
  ogTitle: SeoInfoValue;
  ogDescription: SeoInfoValue;
  ogType: SeoInfoValue;
  robots: string;
  pageType: string;
}

/**
 * Load the SEO info of a page in the chat's view.
 *
 * @param draft the page as the chat's draft has it (title included)
 * @param mainTitle the page's title on main; null when main has no such
 *   page (it was created in the draft)
 */
export async function loadPageSeoInfo(
  ctx: ExecutionContext,
  draft: { readonly id: string; readonly title: string },
  mainTitle: string | null,
): Promise<PageSeoInfo | { readonly error: string }> {
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, ctx, "pages_seo.get", { pageId: draft.id });
  if (!r.ok) {
    // Loud, but never the whole editor: the info shows the failure instead.
    console.error("[edit] page SEO read failed", { pageId: draft.id, error: r.error });
    return { error: "This page's SEO could not be read — reload the editor to try again." };
  }
  const { seo, resolved } = r.value as { seo: SeoRow | null; resolved: ResolvedHead | null };
  if (resolved === null) {
    console.error("[edit] page SEO has no resolved head", { pageId: draft.id });
    return { error: "This page's SEO could not be read — reload the editor to try again." };
  }
  const images = await execute(registry, adapter, ctx, "pages_seo.share_images", {
    pageIds: [draft.id],
  });
  if (!images.ok) {
    console.error("[edit] page share image read failed", {
      pageId: draft.id,
      error: images.error,
    });
    return { error: "This page's SEO could not be read — reload the editor to try again." };
  }
  const image = (images.value as { images: { source: ShareImageSource; url: string | null }[] })
    .images[0];
  const newPage = mainTitle === null;
  const pending = [
    ...(newPage || mainTitle !== draft.title ? ["title"] : []),
    ...(seo?.pendingFields ?? []),
  ];
  return {
    title: resolved.title,
    metaDescription: resolved.metaDescription,
    ogTitle: resolved.ogTitle,
    ogDescription: resolved.ogDescription,
    ogType: resolved.ogType,
    robots: resolved.robots,
    pageType: resolved.pageType,
    ogImageUrl: image?.url ?? null,
    ogImageSource: image?.source ?? "none",
    canonicalUrl: seo?.canonicalUrl ?? null,
    noindex: seo?.noindex ?? false,
    pending,
    newPage,
  };
}
