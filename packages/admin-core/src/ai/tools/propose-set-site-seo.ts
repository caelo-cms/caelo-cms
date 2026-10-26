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
  when:
    "Set site-wide SEO settings. Read current values with `get_site_seo` first.\n" +
    "USE FOR: site status `Site URL: not configured`; publish failed with `Site base URL is not configured`; preview flags `site-base-url-unset`; operator names the site's domain or asks for sitemap / organization changes.\n" +
    "DO NOT USE FOR: site language (`set_site_identity`); per-page SEO (`set_page_seo_many`).\n" +
    "CORE RULES: pass only changed fields (omitted keep their value), except while the base URL is unset every proposal must include `siteBaseUrl`.",
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
    "Read site-wide SEO settings: `siteBaseUrl` (null = unset, publishing fails), `sitemapEnabled`, `organizationJson`. Change via `propose_set_site_seo`. Per-page SEO: `get_page_seo`; site language: `get_site_defaults`.",
  opName: "site_defaults.get_seo",
  input: z.object({}).strict(),
  format: (value) => {
    const v = value as {
      siteBaseUrl: string | null;
      sitemapEnabled: boolean;
      organizationJson: Record<string, unknown>;
    };
    return [
      `siteBaseUrl: ${v.siteBaseUrl ?? "(not configured — publishing fails until propose_set_site_seo({siteBaseUrl}) is approved)"}`,
      `sitemapEnabled: ${v.sitemapEnabled}`,
      `organizationJson: ${JSON.stringify(v.organizationJson)}`,
    ].join("\n");
  },
});
