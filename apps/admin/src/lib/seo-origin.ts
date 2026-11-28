// SPDX-License-Identifier: MPL-2.0

/**
 * #1752 — where a page's SEO value comes from, in the operator's words: the
 * editor's SEO info and the page's SEO panel say it the same way. The
 * values come from `pages_seo.get`'s `resolved` head (`resolvePageSeoHead`).
 */

import type { SeoValueOrigin } from "@caelo-cms/shared";

/** A resolved head value as the panels receive it. */
export interface SeoOriginValue {
  readonly value: string;
  readonly origin: SeoValueOrigin;
  readonly template?: string | null;
  readonly inheritsFrom?: string | null;
}

const INHERITED_FROM: Readonly<Record<string, string>> = {
  seoTitle: "Same as the SEO title.",
  pageTitle: "Same as the page title.",
  metaDescription: "Same as the meta description.",
};

/**
 * One sentence on where `v` comes from; "" for a value that is not set.
 *
 * @param pageType the slug of the page's type (its templates are named after it)
 */
export function seoOriginText(v: SeoOriginValue, pageType: string): string {
  switch (v.origin) {
    case "human":
      return "Written for this page by a person.";
    case "ai":
      return "Written by the AI, not reviewed yet.";
    case "reviewed":
      return "Written by the AI, reviewed by a person.";
    case "page_type":
      return v.template
        ? `From the title template of "${pageType}" pages: ${v.template}`
        : `Set for all "${pageType}" pages.`;
    case "site":
      return v.template ? `From the site's title template: ${v.template}` : "The site's default.";
    case "inherited":
      return INHERITED_FROM[v.inheritsFrom ?? ""] ?? "Shared from another value of this page.";
    default:
      return "";
  }
}
