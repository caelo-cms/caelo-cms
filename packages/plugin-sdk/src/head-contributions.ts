// SPDX-License-Identifier: MPL-2.0

/**
 * #391, #1729 — what a plugin may add to a page's `<head>` and sitemap
 * entry (docs/dev/external-plugin-brokers.md §6.2), for every plugin,
 * shipped or installed (decision Q2 A).
 *
 * CLAUDE.md §2: no raw HTML into `<head>`, SEO is structured fields only.
 * A plugin therefore answers with typed entries from a closed vocabulary,
 * and core serializes them:
 *
 * - `link`: only `rel="alternate"` with an `hreflang`, naming the other
 *   version by its page id. Core builds the URL with the builder that
 *   makes the page's canonical, so a plugin can never point an alternate
 *   off the site (an SEO hijack) or at a URL that disagrees with the
 *   target's canonical (#590). A stylesheet, preconnect or prefetch
 *   (`rel` anything else) would load a third party before consent.
 * - `meta`: only `property` `og:locale` and `og:locale:alternate`. Core's
 *   SEO fields own everything else; a plugin's `robots: noindex` could take
 *   the whole site out of search.
 * - sitemap: `exclude`, and `alternates` by page id.
 *
 * At most {@link HEAD_ENTRIES_PER_PAGE} head entries and as many sitemap
 * alternates per page, and {@link HEAD_ANSWER_MAX_BYTES} per answer. The
 * host refuses anything else, names the rule, and the refusal is a render
 * failure: the editor preview lists it, a Stage records it and Publish live
 * refuses the build. It is never silently dropped.
 */

import { z } from "zod";

/** Head entries per page, and sitemap alternates per page, a plugin may answer. */
export const HEAD_ENTRIES_PER_PAGE = 20;

/** The largest head-contribution answer one call may return, serialized. */
export const HEAD_ANSWER_MAX_BYTES = 1024 * 1024;

/** The `meta` properties a plugin may set. */
export const HEAD_META_PROPERTIES = ["og:locale", "og:locale:alternate"] as const;

/** A `meta` property a plugin may set. */
export type HeadMetaProperty = (typeof HEAD_META_PROPERTIES)[number];

/** An `hreflang`: a BCP 47 language tag (`de`, `pt-BR`) or `x-default`. */
export const hreflangValue = z
  .string()
  .max(35)
  .regex(
    /^(?:x-default|[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*)$/,
    "hreflang is a BCP 47 language tag such as `de` or `pt-BR`, or `x-default`",
  );

/** An `og:locale` value: `language_TERRITORY` (`de_DE`) or a bare language (`de`). */
export const ogLocaleValue = z
  .string()
  .max(16)
  .regex(
    /^[a-z]{2,3}(?:_(?:[A-Z]{2}|[0-9]{3}))?$/,
    "og:locale is language_TERRITORY such as `de_DE`, or a language such as `de`",
  );

/**
 * One per-page `<head>` entry. Core serializes and escapes it; the same
 * serializer feeds the static generator and the editor preview (byte
 * parity).
 */
export const headEntry = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("link"),
      rel: z.literal("alternate"),
      hreflang: hreflangValue,
      /** The page this alternate names. Core builds its URL. */
      pageId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("meta"),
      property: z.enum(HEAD_META_PROPERTIES),
      content: ogLocaleValue,
    })
    .strict(),
]);

/** One per-page `<head>` entry a plugin answers. */
export type HeadEntry = z.infer<typeof headEntry>;

/** One sitemap alternate: the other version of the page, by its page id. */
export const sitemapAlternate = z
  .object({
    hreflang: hreflangValue,
    /** The page this alternate names. Core builds its URL. */
    pageId: z.string().uuid(),
  })
  .strict();

/** Per-page sitemap adjustments a plugin answers. */
export const sitemapContribution = z
  .object({
    /** Drop this page from the sitemap (an unpublished language version:
     *  clean-404 semantics). */
    exclude: z.boolean().optional(),
    /** xhtml alternate links of the page's `<url>` entry. */
    alternates: z.array(sitemapAlternate).optional(),
  })
  .strict();

/** Per-page sitemap adjustments a plugin answers. */
export type SitemapContribution = z.infer<typeof sitemapContribution>;
