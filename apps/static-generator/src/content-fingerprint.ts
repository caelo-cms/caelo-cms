// SPDX-License-Identifier: MPL-2.0

/**
 * The fingerprint of what a page itself shows (docs/dev/search-engine-feed.md):
 * its title, its meta description, and the visible text, link targets, image
 * sources and alternative texts of its own body — the template with the
 * page's modules, never the layout's header and footer.
 *
 * Search engines want a page's date to move when its content changes, not
 * when a class name, a script or a shared footer does: a date that moves on
 * every Publish live is soon ignored. So markup, styles, scripts and every
 * attribute but the ones that carry content are left out, and whitespace
 * runs count as one space.
 *
 * What plugins bake into a page (`staticRender`: approved comments, a
 * language switcher) is a second fingerprint, {@link pluginRegionsDigest}.
 * A plugin renders one region per page wherever its placeholder sits, so
 * every region of the page counts. It is taken from the finished page —
 * after the build's plugin pass, and by the plugin-data build from the live
 * files it re-bakes (#1155) — so both reach the same value for the same
 * output.
 */

import { createHash } from "node:crypto";
import { Parser } from "htmlparser2";
import { findBakeRegions } from "./bake-regions.js";

/** Elements whose content is never shown as text. */
const SKIPPED = new Set(["script", "style"]);

/** Attributes that carry content: where a link goes, what an image shows. */
const CONTENT_ATTRIBUTES = ["href", "src", "srcset", "alt", "poster"] as const;

/**
 * The page body reduced to what it shows: text with whitespace collapsed,
 * plus one `attr=value` token per content attribute, in document order.
 */
export function visibleContent(html: string): string {
  const parts: string[] = [];
  let skipping = 0;
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (SKIPPED.has(name)) {
          skipping += 1;
          return;
        }
        if (skipping > 0) return;
        for (const attr of CONTENT_ATTRIBUTES) {
          const value = attributes[attr];
          if (value !== undefined && value.trim().length > 0) {
            parts.push(` \u0001${attr}=${value.trim()} `);
          }
        }
      },
      ontext(text) {
        if (skipping === 0) parts.push(text);
      },
      onclosetag(name) {
        if (SKIPPED.has(name) && skipping > 0) skipping -= 1;
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();
  return parts.join("").replace(/\s+/g, " ").trim();
}

/**
 * sha256 (hex) of the {@link visibleContent} of a page body. Taken when the
 * page is composed, so the body HTML need not be kept until the SEO pass.
 */
export function bodyContentDigest(bodyHtml: string): string {
  return createHash("sha256").update(visibleContent(bodyHtml)).digest("hex");
}

/**
 * sha256 (hex) of the page's title, description and body digest — and
 * (#1752) the `<title>` search results show, when it is not the page title
 * (an own SEO title, a title template). A page whose `<title>` is its title
 * fingerprints exactly as before, so no page counts as changed by the
 * upgrade alone; the page title always counts, as the feed and the JSON-LD
 * name show it.
 */
export function pageContentFingerprint(page: {
  readonly title: string;
  readonly metaDescription: string;
  readonly bodyDigest: string;
  readonly headTitle?: string;
}): string {
  const hash = createHash("sha256")
    .update(page.title.trim())
    .update("\u0000")
    .update(page.metaDescription.trim())
    .update("\u0000")
    .update(page.bodyDigest);
  if (page.headTitle !== undefined && page.headTitle.trim() !== page.title.trim()) {
    hash.update("\u0000").update(page.headTitle.trim());
  }
  return hash.digest("hex");
}

/**
 * sha256 (hex) of what the plugins baked into a finished page show: the
 * {@link visibleContent} of each plugin's region, in slug order. Null when
 * no plugin bakes into the page. The bake markers and the wrapper's
 * `data-baked-at` carry no content, so a fresh bake of the same data gives
 * the same digest.
 */
export function pluginRegionsDigest(pageHtml: string): string | null {
  const bySlug = new Map<string, string>();
  for (const region of findBakeRegions(pageHtml)) {
    if (!bySlug.has(region.slug)) bySlug.set(region.slug, visibleContent(region.text));
  }
  if (bySlug.size === 0) return null;
  const hash = createHash("sha256");
  for (const slug of [...bySlug.keys()].sort()) {
    hash
      .update(slug)
      .update("\u0000")
      .update(bySlug.get(slug) ?? "")
      .update("\u0000");
  }
  return hash.digest("hex");
}
