// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/plugin-seo — the SEO knowledge that changes with search
 * engines, as a plugin (epic #1751, CMS_REQUIREMENTS §14.11).
 *
 * The architecture rule of the epic: core writes everything that reaches a
 * page (head, JSON-LD, sitemap, robots.txt, files); this plugin answers with
 * typed data only — schema nodes, findings, write hints, proposals — and
 * holds the knowledge of which schema type fits which page type, which
 * fields search engines read and which rules are objective. Plugin code has
 * no network and owns no routes (#1729).
 *
 * Layout (each feature in modules of its own; README.md):
 * - `operations.ts` — every operation by name, the hooks below name them.
 * - `checks/` — the Stage audit: objective rules only, errors block Publish
 *   live (`SEO_AUDIT_RULES`).
 * - `hints/` — write hints after the AI writes: rules of thumb, never
 *   findings (`SEO_WRITE_HINT_RULES`).
 * - `tools.ts`, `skills.ts`, `config.ts` — the AI's tools, the companion
 *   skills and the settings.
 */

import { definePlugin, type PluginContextTier1 } from "@caelo-cms/plugin-sdk";
import { SEO_CONFIG } from "./config.js";
import { AUDIT_OPERATION, SEO_OPERATIONS, WRITE_HINTS_OPERATION } from "./operations.js";
import { MAPPINGS_TABLE } from "./schema/mapping.js";
import { SITEMAP_ENTRIES_OPERATION, STRUCTURED_DATA_OPERATION } from "./schema/operations.js";
import { SEO_SKILLS } from "./skills.js";
import { SEO_TOOLS } from "./tools.js";
import { OBSERVE_OPERATION } from "./topics/operations.js";
import { PAGE_INDEX_TABLE } from "./topics/page-index.js";

export default definePlugin<PluginContextTier1>({
  slug: "seo",
  version: "1.0.0",
  tier: 1,
  requestedCapabilities: [
    "cms_admin",
    "cms_admin_schema",
    "chat_runner_tools",
    "companion_skills",
    "structured_data",
    "sitemap_entries",
    "page_output",
  ],
  capabilityReasons: {
    cms_admin:
      "Reads pages, page types, lists and redirects to suggest topic pages and links, and to check the staged site.",
    cms_admin_schema: "Keeps the schema mapping per page type as draft data of its own.",
    chat_runner_tools: "Gives the AI tools to set up structured data, author and topic pages.",
    companion_skills: "Teaches the AI how to set up structured data, author and topic pages.",
    structured_data:
      "Describes articles, their authors and reviewers, author pages and overview pages in each page's structured data.",
    sitemap_entries: "Lists recent news articles and video pages in the news and video sitemaps.",
    page_output:
      "Reads each Stage's published pages (their terms and links) to count articles per topic and suggest internal links.",
  },
  // No visitor-facing surface: everything this plugin knows reaches a page
  // as data core serializes.
  schema: {},
  publicOperations: [],
  adminSchema: {
    /** #1756 — the schema mapping of each page type (schema/mapping.ts). */
    [MAPPINGS_TABLE]: { page_type: "string", schema_type: "string", roles: "jsonb" },
    /** #1759 — the published site as each Stage delivers it (topics/page-index.ts). */
    [PAGE_INDEX_TABLE]: {
      page_id: "string",
      path: "string",
      title: "string",
      page_type: "string",
      terms: "jsonb",
      links: "jsonb",
      indexable: "bool",
    },
  },
  indexes: {
    adminSchema: { [MAPPINGS_TABLE]: [["page_type"]], [PAGE_INDEX_TABLE]: [["page_id"]] },
  },
  aiReadableTables: [MAPPINGS_TABLE],
  config: SEO_CONFIG,
  structuredDataOperation: STRUCTURED_DATA_OPERATION,
  sitemapEntriesOperation: SITEMAP_ENTRIES_OPERATION,
  pageOutputObserver: { operation: OBSERVE_OPERATION },
  auditFindingsOperation: AUDIT_OPERATION,
  writeHintsOperation: WRITE_HINTS_OPERATION,
  tools: SEO_TOOLS,
  skills: SEO_SKILLS,
  operations: SEO_OPERATIONS,
});
