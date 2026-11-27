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
  STRUCTURED_DATA_OPERATION,
  setSchemaMappings,
  structuredData,
} from "./schema/operations.js";

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
  get_schema_mapping: (ctx, args) => getSchemaMapping(ctx, args),
  set_schema_mappings_many: (ctx, args) => setSchemaMappings(ctx, args),
};
