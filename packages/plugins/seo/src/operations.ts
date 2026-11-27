// SPDX-License-Identifier: MPL-2.0

/**
 * Every operation of the seo plugin, by name. The definition's hooks and
 * tools name these; each feature adds its operations here, from a module of
 * its own.
 */

import type { PluginContextTier1, PluginOperation } from "@caelo-cms/plugin-sdk";
import { AGENT_FILES_OPERATION, agentFiles } from "./agent-files.js";
import { seoAudit } from "./checks/index.js";
import {
  PLAN_CRAWLER_POLICY_OPERATION,
  planCrawlerPolicyOperation,
} from "./crawlers/operations.js";
import { seoWriteHints } from "./hints/index.js";

/** The operation core calls at every Stage audit (`auditFindingsOperation`). */
export const AUDIT_OPERATION = "audit";

/** The operation core calls after the AI wrote (`writeHintsOperation`). */
export const WRITE_HINTS_OPERATION = "write_hints";

/** Every operation, by name. */
export const SEO_OPERATIONS: Readonly<Record<string, PluginOperation<PluginContextTier1>>> = {
  [AUDIT_OPERATION]: (ctx, args) => seoAudit(ctx, args),
  [WRITE_HINTS_OPERATION]: (ctx, args) => seoWriteHints(ctx, args),
  [PLAN_CRAWLER_POLICY_OPERATION]: (ctx, args) => planCrawlerPolicyOperation(ctx, args),
  [AGENT_FILES_OPERATION]: (ctx) => agentFiles(ctx),
};
