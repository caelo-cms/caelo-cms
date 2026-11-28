// SPDX-License-Identifier: MPL-2.0

/**
 * #1760 — the editor toolbar place next to the page address: how the page
 * appears in a search result (desktop and phone, cut where a result list
 * cuts, ./serp-width.ts) and as a shared link (its Open Graph title,
 * description and image). It reads the resolved values in the chat's view
 * (a render invocation on the editor's branch), so it shows the draft, and
 * it only displays: the prompts are for the operator to send.
 */

import {
  type PluginContextTier1,
  type PluginEditorToolbarItem,
  type PluginEditorToolbarState,
  z,
} from "@caelo-cms/plugin-sdk";
import { cutToWidth, DESCRIPTION_FONT_PX, SERP_LIMITS, TITLE_FONT_PX } from "./serp-width.js";

/** The operation the toolbar place calls with `{ pageId }`. */
export const SEO_PREVIEW_OPERATION = "seo_preview";

/** The toolbar place's declaration. */
export const SEO_PREVIEW_TOOLBAR: PluginEditorToolbarItem = {
  id: "search-preview",
  title: "Search and share preview",
  icon: "search",
  operation: SEO_PREVIEW_OPERATION,
  permission: "content.read",
  prompts: [
    {
      label: "Improve title and text",
      text: "Improve the SEO title and meta description of {page}.",
    },
    {
      label: "Check this page's SEO",
      text: "Check the SEO of {page} and fix what the audit finds.",
    },
  ],
};

const value = z.object({ value: z.string(), origin: z.string() }).passthrough();
const pageSeo = z
  .object({
    resolved: z
      .object({
        title: value,
        metaDescription: value,
        ogTitle: value,
        ogDescription: value,
        robots: z.string(),
      })
      .passthrough()
      .nullable(),
  })
  .passthrough();

const urls = z.object({ urls: z.record(z.string(), z.string()) }).strict();
const shareImages = z
  .object({
    images: z.array(z.object({ pageId: z.string(), assetId: z.string().nullable() }).passthrough()),
  })
  .passthrough();

/** `example.com › blog › post`, as a result list shows an address. */
export function displayUrl(url: string): string {
  const u = new URL(url);
  const parts = u.pathname.split("/").filter((p) => p !== "");
  return [u.host, ...parts.map((p) => decodeURIComponent(p))].join(" › ").slice(0, 300);
}

/**
 * The page's URL as a result list shows it. A canonical override may be
 * site-relative (`/preferred-page/`), which `pages.resolve_public_urls`
 * passes on as written; it is resolved against the site's base URL.
 */
async function absoluteUrl(ctx: PluginContextTier1, url: string): Promise<string> {
  if (URL.canParse(url)) return url;
  const { siteBaseUrl } = z
    .object({ siteBaseUrl: z.string().nullable() })
    .passthrough()
    .parse(await ctx.cms?.call("site_defaults.get_seo", {}));
  // resolve_public_urls refuses without a base URL, so it is set here.
  if (!siteBaseUrl) throw new Error("seo: the site base URL is not set, so no page has an address");
  return new URL(url, siteBaseUrl).href;
}

/** Text a preview field takes: one line, within the SDK's length. */
function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** `seo_preview`: the place's state for one page. */
export async function seoPreview(
  ctx: PluginContextTier1,
  rawArgs: unknown,
): Promise<PluginEditorToolbarState> {
  if (!ctx.cms) throw new Error("seo: the cms_admin grant is missing, so page SEO cannot be read");
  const { pageId } = z.object({ pageId: z.string().uuid() }).strict().parse(rawArgs);
  const seo = pageSeo.parse(await ctx.cms.call("pages_seo.get", { pageId }));
  const head = seo.resolved;
  if (!head) return { hidden: true };
  const url = urls.parse(
    await ctx.cms.call("pages.resolve_public_urls", {
      pageIds: [pageId],
      pageUrlStyle: "directory",
    }),
  ).urls[pageId];
  if (!url) throw new Error(`seo: no public URL for page ${pageId}`);
  const pageUrl = await absoluteUrl(ctx, url);
  const image =
    shareImages
      .parse(await ctx.cms.call("pages_seo.share_images", { pageIds: [pageId] }))
      .images.find((i) => i.pageId === pageId)?.assetId ?? null;
  const host = new URL(pageUrl).host;
  const title = head.title.value || head.ogTitle.value;
  const results = (["desktop", "mobile"] as const).map((device) => ({
    kind: "search-result" as const,
    device,
    siteName: clip(host, 120),
    displayUrl: displayUrl(pageUrl),
    title: clip(
      cutToWidth(title || "(no title)", TITLE_FONT_PX, SERP_LIMITS[device].title).text,
      200,
    ),
    description: clip(
      cutToWidth(head.metaDescription.value, DESCRIPTION_FONT_PX, SERP_LIMITS[device].description)
        .text,
      400,
    ),
  }));
  const titleCut = cutToWidth(title, TITLE_FONT_PX, SERP_LIMITS.desktop.title).cut;
  const missing = head.metaDescription.origin === "unset";
  const noindex = head.robots.split(",").some((d) => d.trim() === "noindex");
  return {
    tone: missing || noindex ? "attention" : "neutral",
    summary: noindex
      ? "noindex: search engines leave this page out; the preview shows what it would look like."
      : missing
        ? "No meta description yet: search engines pick text from the page."
        : titleCut
          ? "The title ends in … on a desktop result; put the words that matter first."
          : "How this page appears in a search result and as a shared link.",
    items: [
      { label: "Title from", detail: head.title.origin.replace("_", " ") },
      { label: "Description from", detail: head.metaDescription.origin.replace("_", " ") },
    ],
    previews: [
      ...results,
      {
        kind: "social-card",
        siteName: clip(host, 120),
        title: clip(head.ogTitle.value || title || "(no title)", 200),
        description: clip(head.ogDescription.value, 400),
        imageAssetId: image,
      },
    ],
  };
}
