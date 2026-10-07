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
  pendingQueuePath: "/security/seo",
  when:
    "Set the site-wide SEO settings: `siteBaseUrl` (the public origin every canonical URL, og:url, hreflang " +
    "target and sitemap entry is built from — publishing FAILS while it is unset), `sitemapEnabled` (emit " +
    "sitemap.xml + the robots.txt Sitemap line) and `organizationJson` (Organization JSON-LD: name, url, logo, " +
    "sameAs — replaces the whole object). Pass only the fields you change; omitted ones keep their value. " +
    "Use it when the site status says `Site URL: not configured`, a publish failed with `Site base URL is not " +
    "configured`, the preview flags `site-base-url-unset`, or the operator names the site's domain or asks for " +
    "sitemap / organization changes. `siteBaseUrl` must be the bare https origin (`https://www.example.com` — " +
    "no path, query or trailing page); a localhost address is refused on cloud installs. Take it from the " +
    "operator's words or the domain they publish under; ask only when you genuinely do not know it. Read the " +
    "current values with get_site_seo first. NOT for the site language — that is set_site_identity({siteLanguage}); " +
    "NOT for per-page SEO — that is set_page_seo.",
  schema: siteSeoProposalInputSchema,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      siteBaseUrl: {
        type: "string",
        minLength: 1,
        maxLength: 2048,
        description: "Public origin of the site, e.g. https://www.example.com (https, no path).",
      },
      sitemapEnabled: { type: "boolean" },
      organizationJson: {
        type: "object",
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
    "Fetch the CURRENT site-wide SEO settings: siteBaseUrl (null = not configured, publishing fails), " +
    "sitemapEnabled, organizationJson. Change them with propose_set_site_seo (Owner-approved). " +
    "Per-page SEO lives on the page (set_page_seo); the site language on get_site_defaults / set_site_identity.",
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
