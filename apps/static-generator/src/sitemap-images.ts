// SPDX-License-Identifier: MPL-2.0

/**
 * #1762 — image entries in the XML sitemap (Google's image sitemap
 * extension, `http://www.google.com/schemas/sitemap-image/1.1`): the media
 * library images a page shows, so image search finds them with the page.
 *
 * Read from the page as it ships, after the media pass published its
 * images: every `<img src>` that is a published library file
 * (`/_assets/<slug>.<hash>.<ext>` or `/_assets/<slug>/<variant>.<hash>.<ext>`).
 * Reference images never reach a page (the build refuses or reports them,
 * #531), an unpublished one (`/_caelo/media/…`, a Stage that reports it)
 * and an image from elsewhere are left out: the sitemap lists what this
 * site publishes. Each image once per page, in document order, at most
 * {@link MAX_SITEMAP_IMAGES_PER_URL} (Google's limit per `<url>`).
 */

/** The image sitemap extension's namespace. */
export const SITEMAP_IMAGE_NS = "http://www.google.com/schemas/sitemap-image/1.1";

/** Most images one `<url>` lists (Google's limit). */
export const MAX_SITEMAP_IMAGES_PER_URL = 1000;

/** A published library file, as the media pass names it. */
const PUBLISHED =
  /^\/_assets\/[a-z0-9][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)?\.[0-9a-f]{16}\.[a-z0-9]{2,5}$/;

/** `<img …>` tags and their `src` attribute (the build writes attributes quoted). */
const IMG_TAG = /<img\b[^>]*>/gi;
const SRC_ATTR = /\ssrc\s*=\s*("([^"]*)"|'([^']*)')/i;

/** The asset a published path belongs to: its first segment after `/_assets/` (the slug). */
function assetOf(path: string): string {
  const rest = path.slice("/_assets/".length);
  const slash = rest.indexOf("/");
  return slash === -1 ? (rest.split(".")[0] as string) : rest.slice(0, slash);
}

/**
 * The absolute URLs of the library images `html` shows, each asset once.
 *
 * @param siteBaseUrl the site's public origin the URLs are built on.
 */
export function sitemapImagesOf(html: string, siteBaseUrl: string): string[] {
  const base = siteBaseUrl.replace(/\/$/, "");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of html.matchAll(IMG_TAG)) {
    const m = SRC_ATTR.exec(tag[0]);
    const src = (m?.[2] ?? m?.[3] ?? "").replace(/&amp;/g, "&");
    if (!PUBLISHED.test(src)) continue;
    const asset = assetOf(src);
    if (seen.has(asset)) continue;
    seen.add(asset);
    out.push(`${base}${src}`);
    if (out.length >= MAX_SITEMAP_IMAGES_PER_URL) break;
  }
  return out;
}

/** The `<image:image>` lines of one `<url>` entry, values escaped as XML. */
export function sitemapImageLines(urls: readonly string[]): string[] {
  return urls.flatMap((u) => [
    "    <image:image>",
    `      <image:loc>${xmlText(u)}</image:loc>`,
    "    </image:image>",
  ]);
}

function xmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
