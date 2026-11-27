// SPDX-License-Identifier: MPL-2.0

/**
 * AI tools for the site SEO settings: `propose_set_site_seo` (§11.A gated,
 * wraps `site_defaults.propose_set_seo` → `site_defaults.execute_proposal`)
 * and `get_site_seo` (read).
 *
 * Before these existed the static generator refused to build with no site
 * base URL and named a settings page, while the agent had no tool to set it
 * — the operator had to leave the chat for a value the agent can usually
 * infer (the install's domain, the source site of a migration).
 */

import { siteSeoProposalInputSchema } from "@caelo-cms/shared";
import { z } from "zod";
import { makeProposeTool } from "./_make-propose-tool.js";
import { makeReadTool } from "./_make-read-tool.js";

export const proposeSetSiteSeoTool = makeProposeTool({
  toolName: "propose_set_site_seo",
  opName: "site_defaults.propose_set_seo",
  pendingQueuePath: "/settings/seo",
  approvalPreviewOp: "site_defaults.preview_set_seo",
  // Epic #1751 — a plugin that knows crawlers (seo: which token serves
  // which purpose, which ones ignore robots.txt) adds its caveats to the card.
  pluginWrites: (args) => {
    const parsed = siteSeoProposalInputSchema.safeParse(args);
    const rules = parsed.success ? parsed.data.robotsRules : undefined;
    return rules === undefined ? [] : [{ kind: "robots_rules", rules }];
  },
  when:
    "Set site-wide SEO settings. Read current values with `get_site_seo` first.\n" +
    "USE FOR: site status `Site URL: not configured`; publish failed with `Site base URL is not configured`; preview flags `site-base-url-unset`; operator names the site's domain or asks for sitemap / feed / IndexNow / organization changes; operator wants pages or crawlers kept out of robots.txt (a search results page, an AI crawler).\n" +
    "DO NOT USE FOR: site language (`set_site_identity`); per-page SEO and noindex (`set_page_seo_many`); a robots.txt file (`propose_set_static_files` refuses it: robots.txt is built from these rules).\n" +
    "CORE RULES: pass only changed fields (omitted keep their value), except while the base URL is unset every proposal must include `siteBaseUrl`. After approval it is saved, not live: offer the Stage; Publish live stays the operator's.",
  schema: siteSeoProposalInputSchema,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      siteBaseUrl: {
        type: "string",
        minLength: 1,
        maxLength: 2048,
        description:
          "Public origin every canonical, og:url, hreflang target and sitemap entry is built from; publishing FAILS while unset. Bare https origin (`https://www.example.com`, no path/query); localhost refused on cloud installs. Take it from the operator's words or their publish domain; ask only if genuinely unknown.",
      },
      sitemapEnabled: {
        type: "boolean",
        description: "Emit sitemap.xml + the robots.txt Sitemap line.",
      },
      feedEnabled: {
        type: "boolean",
        description:
          "Emit /feed.xml (Atom, the pages changed last), link it from every page and robots.txt, and ping the WebSub hub after each Publish live.",
      },
      indexNowEnabled: {
        type: "boolean",
        description:
          "Serve the IndexNow key file and submit the URLs each Publish live changed (Bing, Yandex, Seznam, Naver, Yep; not Google).",
      },
      organizationJson: {
        type: "object",
        description: "Organization JSON-LD; REPLACES the whole object.",
        additionalProperties: false,
        properties: {
          name: { type: "string", maxLength: 256 },
          url: { type: "string", maxLength: 2048 },
          logo: { type: "string", maxLength: 2048 },
          sameAs: { type: "array", maxItems: 20, items: { type: "string", maxLength: 2048 } },
        },
      },
      robotsRules: {
        type: "array",
        maxItems: 20,
        description:
          "robots.txt rules of the live site; REPLACES the whole list (send the groups to keep; [] removes all). Without a `*` group the file says `User-agent: * / Allow: /`; staging always blocks every crawler. One group per crawler: `*` (every crawler) stands alone, each user agent in one group only. A crawler follows ONLY the most specific group naming it, so a named crawler's group (`GPTBot`) repeats the `*` paths that should bind it too. Paths start with `/`; `*` matches anything, a closing `$` ends the match. Disallow stops crawling, not indexing: a page that must vanish from search keeps noindex and stays crawlable until it is gone, and a search results page is noindex AND disallowed (each language's path). `Disallow: /` for `*` takes the whole site out of search: only when the operator says so.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["userAgents"],
          properties: {
            userAgents: {
              type: "array",
              minItems: 1,
              maxItems: 10,
              items: { type: "string", maxLength: 64 },
              description:
                '`*`, or crawler product tokens (`Googlebot`, `GPTBot`, `CCBot`), or alone `__usage_ai-training` (training preference: `disallow: ["/"]` = do not train; no crawler, no contentSignal).',
            },
            contentSignal: {
              type: "object",
              additionalProperties: false,
              description:
                '`Content-Signal` line: may these crawlers use the site for search results, AI answers (aiInput), AI training (aiTrain). A preference, blocks nothing; keep `allow`/`disallow` (a group needs a path, e.g. `allow: ["/"]`).',
              properties: {
                search: { type: "boolean" },
                aiInput: { type: "boolean" },
                aiTrain: { type: "boolean" },
              },
            },
            allow: { type: "array", maxItems: 50, items: { type: "string", maxLength: 512 } },
            disallow: {
              type: "array",
              maxItems: 50,
              items: { type: "string", maxLength: 512 },
              description: "e.g. `/de/suche/`, `/en/search/`, `/*?q=`.",
            },
          },
        },
      },
    },
  },
  // Field names only: the chat's proposal parser ends the summary at the
  // first "." and a URL value would cut it short.
  summarize: (_input, preview) =>
    `change site SEO settings (${Object.keys((preview.changes ?? {}) as object).join(", ")})`,
});

export const getSiteSeoTool = makeReadTool<Record<string, never>>({
  name: "get_site_seo",
  description:
    "Read site-wide SEO settings: `siteBaseUrl` (null = unset, publishing fails), `sitemapEnabled`, `feedEnabled`, `indexNowEnabled`, `organizationJson`, the robots.txt rules with the live file they make, the site's `<title>` template and name, and how the latest WebSub pings / IndexNow submissions went. Change via `propose_set_site_seo`; the title template via `set_page_type_seo_many`. Per-page SEO: `get_page_seo`; default share image: `set_theme_asset` slot socialShare; site language: `get_site_defaults`.",
  opName: "site_defaults.get_seo",
  input: z.object({}).strict(),
  format: (value) => {
    const v = value as {
      siteBaseUrl: string | null;
      sitemapEnabled: boolean;
      feedEnabled: boolean;
      indexNowEnabled: boolean;
      organizationJson: Record<string, unknown>;
      robotsRules: unknown[];
      robotsTxt: string | null;
      robotsWarnings: string[];
      robotsNotes: string[];
      titleTemplate: string;
      siteName: string | null;
      searchNotifications: {
        channel: string;
        status: string;
        urlCount: number;
        detail: string | null;
        createdAt: string;
      }[];
    };
    return [
      `siteBaseUrl: ${v.siteBaseUrl ?? "(not configured — publishing fails until propose_set_site_seo({siteBaseUrl}) is approved)"}`,
      `sitemapEnabled: ${v.sitemapEnabled}`,
      `feedEnabled: ${v.feedEnabled}`,
      `indexNowEnabled: ${v.indexNowEnabled}`,
      `organizationJson: ${JSON.stringify(v.organizationJson)}`,
      `titleTemplate: \`${v.titleTemplate}\` (pages whose type has none)`,
      `siteName (og:site_name, {site_name}): ${v.siteName ?? "(not set — set_site_identity)"}`,
      `robotsRules: ${JSON.stringify(v.robotsRules)}`,
      ...v.robotsWarnings.map((w) => `robots WARNING: ${w}`),
      ...v.robotsNotes.map((n) => `robots NOTE: ${n}`),
      v.robotsTxt === null
        ? "robots.txt: (none until the site URL is set)"
        : `robots.txt of the live site after the next Stage + Publish live (staging blocks every crawler):\n${v.robotsTxt.trimEnd()}`,
      v.searchNotifications.length === 0
        ? "search engine notifications: none yet (sent after a Publish live)"
        : `search engine notifications (newest first):\n${v.searchNotifications
            .map(
              (n) =>
                `- ${n.createdAt} ${n.channel} ${n.status}${n.channel === "indexnow" ? ` (${n.urlCount} URLs)` : ""}${n.detail ? `: ${n.detail}` : ""}`,
            )
            .join("\n")}`,
    ].join("\n");
  },
});
