// SPDX-License-Identifier: MPL-2.0

/**
 * Every operation of the seo plugin, by name. The definition's hooks and
 * tools name these; each feature adds its operations here, from a module of
 * its own.
 */

import type { PluginContextTier1, PluginOperation } from "@caelo-cms/plugin-sdk";
import { seoAudit } from "./checks/index.js";
import { seoWriteHints } from "./hints/index.js";
import { AUDIT_RULES, WRITE_HINT_RULES } from "./rule-sets.js";
import { AGENT_FILES_OPERATION, agentFiles } from "./rules/agent-files.js";
import {
  PLAN_CRAWLER_POLICY_OPERATION,
  planCrawlerPolicyOperation,
} from "./rules/crawler-operations.js";
import {
  OVERVIEW_PAGE_TYPES_OPERATION,
  OVERVIEW_ROWS_OPERATION,
  overviewPageTypes,
  overviewRows,
} from "./rules/overview.js";
import { SEO_PREVIEW_OPERATION, seoPreview } from "./rules/previews.js";

/** The operation core calls at every Stage audit (`auditFindingsOperation`). */
export const AUDIT_OPERATION = "audit";

/** The operation core calls after the AI wrote (`writeHintsOperation`). */
export const WRITE_HINTS_OPERATION = "write_hints";

/** Every operation, by name. */
export const SEO_OPERATIONS: Readonly<Record<string, PluginOperation<PluginContextTier1>>> = {
  [AUDIT_OPERATION]: (ctx, args) => seoAudit(ctx, args, AUDIT_RULES),
  [WRITE_HINTS_OPERATION]: (ctx, args) => seoWriteHints(ctx, args, WRITE_HINT_RULES),
  [PLAN_CRAWLER_POLICY_OPERATION]: (ctx, args) => planCrawlerPolicyOperation(ctx, args),
  [AGENT_FILES_OPERATION]: (ctx) => agentFiles(ctx),
  [OVERVIEW_ROWS_OPERATION]: (ctx, args) => overviewRows(ctx, args),
  [OVERVIEW_PAGE_TYPES_OPERATION]: (ctx) => overviewPageTypes(ctx),
  [SEO_PREVIEW_OPERATION]: (ctx, args) => seoPreview(ctx, args),
};
