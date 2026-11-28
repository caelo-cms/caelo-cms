// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #727 — the findings shape every quality check reports in.
 *
 * A finding is one thing a check saw on the staged build: which rule it
 * broke, how bad it is, where (a page, or the site as a whole), what the AI
 * should do about it. The shape is validated with Zod wherever findings
 * cross a boundary — a check's return value (checks contributed by plugins
 * are untrusted input), the worker → `quality_audits.record_result`
 * hand-over, and the read ops.
 *
 * Severity decides the gate (maintainer decision on #727): an `error` the
 * ratchet does not cover blocks Publish live, exactly like a Lighthouse
 * problem; `warning` and `info` are reported but never block.
 */

import { truncateKeepingIds } from "@caelo-cms/shared";
import { z } from "zod";

/** A UTF-16 surrogate with no partner: half of a character such as an emoji. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Text as Postgres stores it in jsonb: a lone surrogate becomes U+FFFD.
 * Findings quote what a check met (a JSON parser's error naming half of an
 * emoji, a text cut between the halves of one), and `JSON.stringify` writes
 * such a half as `\ud83d`, which jsonb refuses: recording the Stage audit
 * would fail on one quoted character. Every finding passes this schema at
 * each boundary (the check's output, the hand-over, the read), so it is
 * done once, here. Text columns get the same U+FFFD from the encoder.
 */
export function storableText(text: string): string {
  return text.replace(LONE_SURROGATE, "\uFFFD");
}

/** A finding's text: within `max` characters, storable in jsonb. */
const findingText = (max: number) => z.string().min(1).max(max).transform(storableText);

/** How bad a finding is. Only `error` can block Publish live. */
export const FINDING_SEVERITIES = ["error", "warning", "info"] as const;

/**
 * A check id: lower-case kebab words, optionally namespaced with one dot
 * (`seo-check`, `seo-check.titles`). `lighthouse` is the built-in browser
 * audit; `plugin.<slug>` files a plugin's audit contributions (the
 * namespace takes a whole plugin slug, up to 55 characters). The id
 * prefixes every rule id the check reports.
 */
export const checkIdSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]{0,39}(\.[a-z][a-z0-9-]{0,54})?$/,
    "a check id is lower-case kebab words, optionally one dot-namespace (e.g. 'seo-check', 'seo-check.titles')",
  );

/**
 * A rule id: `<checkId>/<rule>` (`seo-check/title-missing`). The slash
 * keeps rule ids apart from Lighthouse audit ids (`image-alt`), which share
 * the acceptance table, and names the check that owns the rule.
 */
export const ruleIdSchema = z
  .string()
  .max(120)
  .regex(
    /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)?\/[a-z][a-z0-9-]*$/,
    "a rule id is '<checkId>/<rule>' in lower-case kebab words (e.g. 'seo-check/title-missing')",
  );

/** Where the AI fixes a finding: the tool to call and what to do with it. */
export const findingFixSchema = z
  .object({
    /** An AI tool name (`set_page_seo_many`, `update_modules_many`, …). */
    tool: z.string().min(1).max(80),
    /** One sentence: what to change, in the tool's terms. */
    hint: findingText(500),
  })
  .strict();

/** One finding as a check reports it. */
export const findingSchema = z
  .object({
    ruleId: ruleIdSchema,
    severity: z.enum(FINDING_SEVERITIES),
    /** The page it is on; absent for a site-wide finding (robots.txt, …). */
    pageId: z.string().uuid().optional(),
    /**
     * AI-actionable (CLAUDE.md §11): what is wrong and why it matters.
     * Lead with a short label before the first colon ("No meta
     * description: …") — the chat's fix offer shows that label per page,
     * next to the page path, so do not repeat the path in it.
     */
    message: findingText(1000),
    fix: findingFixSchema.optional(),
  })
  .strict();

export type Finding = z.infer<typeof findingSchema>;
export type FindingFix = z.infer<typeof findingFixSchema>;

/** The check id a rule id belongs to (`seo-check/x` → `seo-check`). */
export function checkIdOfRule(ruleId: string): string {
  const slash = ruleId.indexOf("/");
  return slash === -1 ? ruleId : ruleId.slice(0, slash);
}

/** The short label a message leads with (text before the first colon). */
export function findingLabel(message: string): string {
  const colon = message.indexOf(": ");
  const label = (colon === -1 ? message : message.slice(0, colon)).trim();
  return truncateKeepingIds(label, 80);
}
