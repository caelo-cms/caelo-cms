// SPDX-License-Identifier: MPL-2.0

/**
 * Every operation of the seo plugin, by name. The definition's hooks and
 * tools name these; each feature adds its operations here, from a module of
 * its own.
 */

import type { PluginContextTier1, PluginOperation } from "@caelo-cms/plugin-sdk";
import { seoAudit } from "./checks/index.js";
import { seoWriteHints } from "./hints/index.js";
import {
  getSchemaMapping,
  SITEMAP_ENTRIES_OPERATION,
  STRUCTURED_DATA_OPERATION,
  setSchemaMappings,
  sitemapEntries,
  structuredData,
} from "./schema/operations.js";
import {
  listTopicTerms,
  mergeTerms,
  OBSERVE_OPERATION,
  observePages,
  suggestInternalLinks,
} from "./topics/operations.js";

/** The operation core calls at every Stage audit (`auditFindingsOperation`). */
export const AUDIT_OPERATION = "audit";

/** The operation core calls after the AI wrote (`writeHintsOperation`). */
export const WRITE_HINTS_OPERATION = "write_hints";

/** Every operation, by name. */
export const SEO_OPERATIONS: Readonly<Record<string, PluginOperation<PluginContextTier1>>> = {
  [AUDIT_OPERATION]: (ctx, args) => seoAudit(ctx, args),
  [WRITE_HINTS_OPERATION]: (ctx, args) => seoWriteHints(ctx, args),
  // #1756 — the schema mapping per page type.
  [STRUCTURED_DATA_OPERATION]: (ctx, args) => structuredData(ctx, args),
  [SITEMAP_ENTRIES_OPERATION]: (ctx, args) => sitemapEntries(ctx, args),
  get_schema_mapping: (ctx, args) => getSchemaMapping(ctx, args),
  set_schema_mappings_many: (ctx, args) => setSchemaMappings(ctx, args),
  // #1759 — topic pages and internal links.
  [OBSERVE_OPERATION]: (ctx, args) => observePages(ctx, args),
  list_topic_terms: (ctx, args) => listTopicTerms(ctx, args),
  merge_terms: (ctx, args) => mergeTerms(ctx, args),
  suggest_internal_links: (ctx, args) => suggestInternalLinks(ctx, args),
};
