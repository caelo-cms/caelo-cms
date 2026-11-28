// SPDX-License-Identifier: MPL-2.0

/**
 * Every audit rule family and write hint family the plugin runs, put
 * together at the package root. The plugin validator lets a file import only
 * from its own folder and below (no `..`), so a family that reads another
 * feature's data lives in that feature's folder and joins the runners here:
 * the topic rules (`topics/`, they read the page index), the structured
 * data rules (`schema/`, they read the type table and the mappings) and the
 * page checks, crawler policy and text hints (`rules/`, epic #1751: #1757,
 * #1758).
 */

import { SEO_AUDIT_RULES, type SeoAuditRule } from "./checks/index.js";
import { SEO_WRITE_HINT_RULES, type SeoWriteHintRule } from "./hints/index.js";
import { ALT_TEXT_HINT_RULE } from "./rules/alt-text-hints.js";
import { CRAWLER_POLICY_AUDIT_RULE, CRAWLER_POLICY_HINT_RULE } from "./rules/crawler-operations.js";
import { DUPLICATES_AUDIT_RULE } from "./rules/duplicates.js";
import { PAGE_AUDIT_RULE } from "./rules/pages-check.js";
import { SEO_TEXT_HINT_RULE } from "./rules/seo-text-hints.js";
import { STRUCTURED_DATA_AUDIT_RULE } from "./schema/data-rules.js";
import { TOPIC_BACKLINK_RULES } from "./topics/backlink-rule.js";
import { TOPIC_LINK_HINTS } from "./topics/link-hints.js";

/** The Stage audit's rule families, in report order. */
export const AUDIT_RULES: readonly SeoAuditRule[] = [
  ...SEO_AUDIT_RULES,
  TOPIC_BACKLINK_RULES,
  CRAWLER_POLICY_AUDIT_RULE,
  DUPLICATES_AUDIT_RULE,
  PAGE_AUDIT_RULE,
  STRUCTURED_DATA_AUDIT_RULE,
];

/** The write hint families, in the order their sentences are shown. */
export const WRITE_HINT_RULES: readonly SeoWriteHintRule[] = [
  ...SEO_WRITE_HINT_RULES,
  TOPIC_LINK_HINTS,
  CRAWLER_POLICY_HINT_RULE,
  ALT_TEXT_HINT_RULE,
  SEO_TEXT_HINT_RULE,
];
