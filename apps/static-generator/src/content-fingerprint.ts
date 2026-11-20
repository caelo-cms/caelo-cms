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
 */

import { createHash } from "node:crypto";
import { Parser } from "htmlparser2";

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

/** sha256 (hex) of the page's title, description and body digest. */
export function pageContentFingerprint(page: {
  readonly title: string;
  readonly metaDescription: string;
  readonly bodyDigest: string;
}): string {
  return createHash("sha256")
    .update(page.title.trim())
    .update("\u0000")
    .update(page.metaDescription.trim())
    .update("\u0000")
    .update(page.bodyDigest)
    .digest("hex");
}
