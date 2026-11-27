// SPDX-License-Identifier: MPL-2.0

/**
 * #1760 — the companion skills of the checks and the crawler policy: an
 * SEO audit of a page or the site, and the crawler policy by purpose (with
 * the llms.txt switch beside it). Written in the operator's terms; the
 * rules that prevent a failed call live in the tool texts.
 */

import type { PluginSkillSpec } from "@caelo-cms/plugin-sdk";

/** "Check the SEO of this page / the site." */
export const SEO_AUDIT_SKILL: PluginSkillSpec = {
  slug: "seo-audit",
  displayName: "SEO audit of a page or the site",
  description:
    "Check a page or the whole site for search: run the Stage audit, fix every SEO finding, and offer the rules of thumb as suggestions.",
  body: [
    "The operator asks whether a page or the site is 'good for Google', why it ranks badly, or for an SEO check. Answer with facts from the audit, not with scores.",
    "",
    "1. Read what the site has: get_page_seo for the page in question (each value with its origin: the page's own, a template, or unset), get_site_seo for robots.txt and the sitemap.",
    "2. Stage the work when the operator wants it checked (stage_changes), then check_stage_audit. The seo plugin's findings are `plugin.seo/<rule>`: one H1, heading order, alt texts, link texts, placeholder text, the share image, noindex pages robots.txt hides, a crawler policy that contradicts itself. Each names its fix tool.",
    "3. Fix every finding you can, in one round per tool (set_page_seo_many, patch_page_module_fields, update_modules_many, set_media_alt_many), then Stage again until the seo findings are gone. A finding blocks Publish live; never call a red audit good enough. What you cannot fix (a real image you cannot see, a decision only the operator can make) goes to the operator as one decision.",
    "4. Rules of thumb are not findings: title and description length, alt text style, a long-unchanged page, a similar page. They arrive as hints after your writes. Mention them as suggestions; do not block on them.",
    "",
    "Do not promise rankings. Search engines rewrite most titles and descriptions; what counts is that crawlers can read the page, that it says what it is about, and that the content is good.",
  ].join("\n"),
  allowlistedTools: [
    "get_page_seo",
    "get_site_seo",
    "stage_changes",
    "check_stage_audit",
    "set_page_seo_many",
    "patch_page_module_fields",
    "update_modules_many",
    "set_media_alt_many",
    "propose_set_site_seo",
  ],
  autoEngagementHints: {
    keywords: ["seo", "google", "ranking", "search engine", "meta description", "h1", "alt text"],
  },
};

/** "Which AI crawlers may read the site?" */
export const CRAWLER_POLICY_SKILL: PluginSkillSpec = {
  slug: "crawler-policy",
  displayName: "Decide which crawlers and AI tools may use the site",
  description:
    "Set the crawler policy by purpose (search, AI answers, AI training, fetches a person asks an AI for) and the optional llms.txt, honestly about what robots.txt can and cannot do.",
  body: [
    "The operator says 'no AI training', 'block ChatGPT', 'should AI see my site?', or asks about llms.txt. They decide purposes; you know the crawlers.",
    "",
    "1. Ask once, in plain words, for the purposes they did not decide: may search engines list the site, may AI answer engines (ChatGPT search, Perplexity) use it, may AI models be trained on it, may an AI fetch a page when a person asks for it? Never assume block.",
    "2. plan_crawler_policy with the four choices. It keeps the site's own robots.txt paths and answers the exact robotsRules and the caveats.",
    "3. propose_set_site_seo with that robotsRules unchanged. The Owner approves the card, which shows the file and the caveats; then offer the Stage. Robots.txt reaches the live site only with Publish live.",
    "4. Tell the operator the caveats as they are: robots.txt is a request, crawlers that ignore it still fetch; Google's AI Overviews come with Google Search (a Search Console setting covers them, not robots.txt); one token can cover several purposes; the training preference token is a new draft not every company reads.",
    "",
    "llms.txt: an optional list of the site's indexable pages for AI tools. Off by default; it is the seo plugin's setting llms_txt (update_plugin_config). Say plainly that it is no ranking lever: Google reads none of it, and most such files are never requested. Coding assistants do read them.",
  ].join("\n"),
  allowlistedTools: [
    "plan_crawler_policy",
    "get_site_seo",
    "propose_set_site_seo",
    "get_plugin_config",
    "update_plugin_config",
    "stage_changes",
  ],
  autoEngagementHints: {
    keywords: ["robots.txt", "crawler", "gptbot", "ai training", "llms.txt", "block ai", "chatgpt"],
  },
};
