// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #727 — the one check core ships with the framework: every rendered
 * page has a non-empty meta description.
 *
 * Why this rule: on searchviu, pages with empty meta descriptions reached
 * the live site and only Lighthouse noticed — on the few pages it audits.
 * This check reads every page of the staged build on every Stage, so an
 * SEO-only Stage that empties a description is caught too.
 *
 * It reads the rendered HTML (what search engines get), not the SEO
 * fields, so it also catches a template or generator that drops the tag.
 * The fuller SEO rule set (title length, canonical, h1, …) belongs to the
 * seo-check plugin (#727 PRs C–F).
 */

import { Parser } from "htmlparser2";
import type { PageCheck, StagedPage } from "../check.js";
import type { Finding } from "../findings.js";

export const PAGE_META_CHECK_ID = "page-meta";
export const DESCRIPTION_MISSING_RULE = `${PAGE_META_CHECK_ID}/description-missing`;

/**
 * The `content` of every `<meta name="description">` in the document, in
 * order (`null` for a tag without a content attribute). Parsing stops at
 * `<body>`: a description outside `<head>` is not a page description.
 */
export function metaDescriptions(html: string): (string | null)[] {
  const found: (string | null)[] = [];
  let inBody = false;
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (name === "body") inBody = true;
        if (inBody || name !== "meta") return;
        if ((attrs.name ?? "").toLowerCase() !== "description") return;
        found.push(attrs.content ?? null);
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();
  return found;
}

function check(page: StagedPage): Finding[] {
  const contents = metaDescriptions(page.html);
  const filled = contents.some((c) => c !== null && c.trim().length > 0);
  if (filled) return [];
  return [
    {
      ruleId: DESCRIPTION_MISSING_RULE,
      severity: "error",
      pageId: page.pageId,
      message:
        contents.length === 0
          ? `No meta description: the rendered page has no <meta name="description">, so search engines show a random text snippet instead.`
          : `Empty meta description: the page's <meta name="description"> has no text, so search engines show a random text snippet instead.`,
      fix: {
        tool: "set_page_seo_many",
        hint: "Write a meta description for each affected page (pageId + metaDescription: one or two sentences, about 120–155 characters, saying what the page offers), all pages in one call; then Stage again.",
      },
    },
  ];
}

/** Rendered pages must carry a non-empty `<meta name="description">`. */
export const pageMetaCheck: PageCheck = {
  id: PAGE_META_CHECK_ID,
  title: "Page meta tags",
  scope: "page",
  run: ({ page }) => check(page),
};
