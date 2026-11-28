// SPDX-License-Identifier: MPL-2.0

/**
 * Every audit rule family and write hint family the plugin runs, put
 * together at the package root. The plugin validator lets a file import only
 * from its own folder and below, so a family that reads another feature's
 * data (the topic rules read the page index) lives in that feature's folder
 * and joins the runners here.
 */

import { SEO_AUDIT_RULES, type SeoAuditRule } from "./checks/index.js";
import { SEO_WRITE_HINT_RULES, type SeoWriteHintRule } from "./hints/index.js";
import { TOPIC_BACKLINK_RULES } from "./topics/backlink-rule.js";
import { TOPIC_LINK_HINTS } from "./topics/link-hints.js";

/** The Stage audit's rule families, in report order. */
export const AUDIT_RULES: readonly SeoAuditRule[] = [...SEO_AUDIT_RULES, TOPIC_BACKLINK_RULES];

/** The write hint families, in the order their sentences are shown. */
export const WRITE_HINT_RULES: readonly SeoWriteHintRule[] = [
  ...SEO_WRITE_HINT_RULES,
  TOPIC_LINK_HINTS,
];
