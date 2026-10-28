// SPDX-License-Identifier: MPL-2.0

/**
 * "View live" for the live editor's Publish live menu: where the shown page
 * and the site are live.
 *
 * The page link is offered only when it is known to be right. Pages reach
 * main with a Stage, and production with the next Publish live, so main's
 * page is what production serves only while production matches the latest
 * staging build. Otherwise (a newer Stage waits, or nothing was published
 * live) the menu says why there is no link instead of pointing at a URL
 * that may not exist yet. The URL comes from core's public URL builder
 * (`resolvePublicPageUrls`, the same as canonical and the sitemap), so a
 * plugin-owned host (international-site's domain and subdomain languages)
 * and the target's trailing-slash style are respected.
 */

import { describeError } from "@caelo-cms/admin-core";
import { MAIN_RENDER, resolvePublicPageUrls } from "@caelo-cms/plugin-host";
import { execute } from "@caelo-cms/query-api";
import type { PageUrlStyle } from "@caelo-cms/shared";
import { getQueryContext } from "./query.js";

/** What the Publish live menu shows. */
export interface LiveLinks {
  /** Why the links could not be built; shown instead of them. */
  readonly error: string | null;
  /** The site's address, or null before it is set (#551). */
  readonly siteUrl: string | null;
  /** The shown page live, or null with `pageNote` saying why not. */
  readonly pageUrl: string | null;
  readonly pageNote: string | null;
}

/** The shown page as main has it, or null when main does not have it. */
export interface MainPage {
  readonly id: string;
  readonly slug: string;
  readonly status: "draft" | "published";
  readonly currentPath: string;
}

/**
 * Whether the page can be linked live, and the reason when it cannot.
 * Pure, so the rule is unit-tested.
 */
export function livePageAvailability(
  mainPage: MainPage | null,
  productionMatchesStaging: boolean | null,
): { live: true } | { live: false; note: string } {
  if (mainPage === null || mainPage.status !== "published") {
    return { live: false, note: "This page is not live: it is a draft or new in this chat." };
  }
  if (productionMatchesStaging === null) {
    return { live: false, note: "Nothing of the current staging is live yet." };
  }
  if (!productionMatchesStaging) {
    return {
      live: false,
      note: "A newer staged build is not live yet, so this page's live address may differ until Publish live.",
    };
  }
  return { live: true };
}

/** Loads the live links for the shown page (`mainPage` as main has it). */
export async function loadLiveLinks(
  ctx: App.Locals["ctx"],
  mainPage: MainPage | null,
  productionMatchesStaging: boolean | null,
): Promise<LiveLinks> {
  const { adapter, registry } = getQueryContext();
  const seoR = await execute(registry, adapter, ctx, "site_defaults.get_seo", {});
  if (!seoR.ok) {
    return { error: describeError(seoR.error), siteUrl: null, pageUrl: null, pageNote: null };
  }
  const siteUrl = (seoR.value as { siteBaseUrl: string | null }).siteBaseUrl;
  if (siteUrl === null) return { error: null, siteUrl: null, pageUrl: null, pageNote: null };

  const availability = livePageAvailability(mainPage, productionMatchesStaging);
  if (!availability.live || mainPage === null) {
    const note = availability.live ? null : availability.note;
    return { error: null, siteUrl, pageUrl: null, pageNote: note };
  }

  const targetsR = await execute(registry, adapter, ctx, "deploy.list_targets", {});
  if (!targetsR.ok) {
    return { error: describeError(targetsR.error), siteUrl, pageUrl: null, pageNote: null };
  }
  const target = (
    targetsR.value as { targets: { isDefault: boolean; pageUrlStyle: PageUrlStyle }[] }
  ).targets.find((t) => t.isDefault);
  if (!target) {
    return {
      error: "No deploy target is marked as the default, so the live address is unknown.",
      siteUrl,
      pageUrl: null,
      pageNote: null,
    };
  }
  // The page's own address, not a canonical override pointing elsewhere.
  const urls = await resolvePublicPageUrls(
    [
      {
        id: mainPage.id,
        slug: mainPage.slug,
        currentPath: mainPage.currentPath,
        canonicalOverride: null,
      },
    ],
    { siteBaseUrl: siteUrl, pageUrlStyle: target.pageUrlStyle },
    MAIN_RENDER,
  );
  return { error: null, siteUrl, pageUrl: urls.get(mainPage.id) ?? null, pageNote: null };
}
