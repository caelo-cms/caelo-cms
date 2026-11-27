// SPDX-License-Identifier: MPL-2.0

/**
 * Every rule family the plugin's two hooks run: the families of
 * `checks/` and `hints/` plus those of `rules/` (the page checks, the
 * crawler policy, alt text style, epic #1751: #1757, #1758).
 *
 * Composed here, at the package root, because the plugin validator lets a
 * file import only its own directory and those below it (no `..`): the
 * runners in `checks/` and `hints/` cannot import `rules/`, while the root
 * may import every directory.
 */

import type { SeoAuditRule } from "./checks/index.js";
import { SEO_AUDIT_RULES } from "./checks/index.js";
import type { SeoWriteHintRule } from "./hints/index.js";
import { SEO_WRITE_HINT_RULES } from "./hints/index.js";
import { ALT_TEXT_HINT_RULE } from "./rules/alt-text-hints.js";
import { CRAWLER_POLICY_AUDIT_RULE, CRAWLER_POLICY_HINT_RULE } from "./rules/crawler-operations.js";
import { DUPLICATES_AUDIT_RULE } from "./rules/duplicates.js";
import { PAGE_AUDIT_RULE } from "./rules/pages-check.js";
import { SEO_TEXT_HINT_RULE } from "./rules/seo-text-hints.js";

/** The Stage audit's rule families, in report order. */
export const AUDIT_RULES: readonly SeoAuditRule[] = [
  ...SEO_AUDIT_RULES,
  CRAWLER_POLICY_AUDIT_RULE,
  DUPLICATES_AUDIT_RULE,
  PAGE_AUDIT_RULE,
];

/** The write hints' families, in the order their sentences are shown. */
export const WRITE_HINT_RULES: readonly SeoWriteHintRule[] = [
  ...SEO_WRITE_HINT_RULES,
  CRAWLER_POLICY_HINT_RULE,
  ALT_TEXT_HINT_RULE,
  SEO_TEXT_HINT_RULE,
];
