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
import { SEO_SKILLS } from "./skills.js";
import { SEO_TOOLS } from "./tools.js";

export default definePlugin<PluginContextTier1>({
  slug: "seo",
  version: "1.0.0",
  tier: 1,
  requestedCapabilities: ["cms_admin", "cms_admin_schema", "chat_runner_tools", "companion_skills"],
  capabilityReasons: {
    cms_admin:
      "Reads pages, page types, lists and redirects to suggest topic pages and links, and to check the staged site.",
    cms_admin_schema: "Keeps the schema mapping per page type as draft data of its own.",
    chat_runner_tools: "Gives the AI tools to set up structured data, author and topic pages.",
    companion_skills: "Teaches the AI how to set up structured data, author and topic pages.",
  },
  // No visitor-facing surface: everything this plugin knows reaches a page
  // as data core serializes.
  schema: {},
  publicOperations: [],
  config: SEO_CONFIG,
  auditFindingsOperation: AUDIT_OPERATION,
  writeHintsOperation: WRITE_HINTS_OPERATION,
  // #1757, #1758 — the SEO texts, alt texts and robots.txt proposals the AI writes too.
  writeHintsKinds: ["module", "values", "robots_rules"],
  tools: SEO_TOOLS,
  skills: SEO_SKILLS,
  operations: SEO_OPERATIONS,
});
