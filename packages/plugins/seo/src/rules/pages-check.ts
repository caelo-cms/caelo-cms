// SPDX-License-Identifier: MPL-2.0

/**
 * #1757 — the rule family of the rendered pages: every rule of
 * ./page-rules.ts on each staged page of a fact batch, and one rule that
 * needs the site's robots.txt rules too:
 *
 * - `noindex-blocked` — a noindex page robots.txt keeps search engines
 *   from fetching. They never read its noindex and may keep listing the
 *   URL (Google: "noindex must be crawlable"); Disallow stops crawling,
 *   not indexing.
 */

import type {
  PluginAuditFinding,
  PluginAuditPageFacts,
  PluginContextTier1,
  RobotsRules,
} from "@caelo-cms/plugin-sdk";
import type { SeoAuditRule } from "../checks/index.js";
import { isNoindex, pageFindings } from "./page-rules.js";
import { mayFetch } from "./robots-match.js";

/** The crawler whose group decides whether search engines read a page. */
const SEARCH_CRAWLER = "Googlebot";

async function robotsRules(ctx: PluginContextTier1): Promise<RobotsRules> {
  if (!ctx.cms)
    throw new Error("seo: the cms_admin grant is missing, so robots.txt cannot be read");
  const r = (await ctx.cms.call("site_defaults.get_seo", {})) as { robotsRules?: unknown };
  if (!Array.isArray(r.robotsRules)) {
    throw new Error("seo: site_defaults.get_seo answered no robotsRules");
  }
  // Core validates the rules at every write and read (robotsRulesSchema).
  return r.robotsRules as RobotsRules;
}

/**
 * The style a page is served in, as crawlers request it: with the trailing
 * slash of a directory-style site (`/private/`), without it on a
 * no-extension one (`/private`). Facts name pages by their identity path,
 * so the style is read from a self-canonical page of the batch (every page
 * of a build shares it). Null when the batch shows none: then only a path
 * blocked in both spellings counts.
 */
export function servedPathStyle(
  facts: readonly PluginAuditPageFacts[],
): "directory" | "no-extension" | null {
  for (const f of facts) {
    const canonical = f.canonical;
    if (f.path === "/" || canonical === null || canonical.path !== f.path) continue;
    if (!URL.canParse(canonical.href)) continue;
    return new URL(canonical.href).pathname.endsWith("/") ? "directory" : "no-extension";
  }
  return null;
}

/** Whether a search engine may fetch the page at `path`, as it is served. */
function fetchable(
  rules: RobotsRules,
  path: string,
  style: "directory" | "no-extension" | null,
): boolean {
  const withSlash = path === "/" ? path : `${path}/`;
  if (style === "directory") return mayFetch(rules, SEARCH_CRAWLER, withSlash);
  if (style === "no-extension") return mayFetch(rules, SEARCH_CRAWLER, path);
  return mayFetch(rules, SEARCH_CRAWLER, path) || mayFetch(rules, SEARCH_CRAWLER, withSlash);
}

/** The rule family over the staged pages' facts. */
export const PAGE_AUDIT_RULE: SeoAuditRule = {
  name: "pages",
  async facts(ctx, { facts }) {
    const out: PluginAuditFinding[] = [];
    for (const f of facts) out.push(...pageFindings(f));
    const noindex = facts.filter(isNoindex);
    if (noindex.length === 0) return out;
    const rules = await robotsRules(ctx);
    const style = servedPathStyle(facts);
    for (const f of noindex) {
      if (fetchable(rules, f.path, style)) continue;
      out.push({
        rule: "noindex-blocked",
        severity: "error",
        pageId: f.pageId,
        message: `noindex not seen: ${f.path} is noindex, but robots.txt keeps search engines from fetching it, so they never read the noindex and may keep listing its URL. Disallow stops crawling, not indexing.`,
        fix: {
          tool: "propose_set_site_seo",
          hint: "Let crawlers reach the page (drop the Disallow that matches its path from robotsRules) until it is out of search; its noindex keeps it out.",
        },
      });
    }
    return out;
  },
};
