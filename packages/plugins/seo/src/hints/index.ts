// SPDX-License-Identifier: MPL-2.0

/**
 * The seo plugin's write hints (core's `writeHintsOperation` hook, epic
 * #1751): sentences appended to the AI's tool result after it wrote module
 * markup or content values, so it can act in the same turn. Rules of thumb
 * (title length, alt text style, "page X covers Y — link?") live here and
 * never become findings; only objective rules are findings (`../checks/`).
 *
 * Every hint family is one {@link SeoWriteHintRule} in
 * {@link SEO_WRITE_HINT_RULES}, each in a file of its own under `hints/`.
 * Core calls the hook as a read-only render invocation on the main line,
 * after the write already happened.
 */

import { type PluginContextTier1, type PluginWrite, z } from "@caelo-cms/plugin-sdk";

type Ctx = PluginContextTier1;

/** One family of write hints: the AI's writes in, sentences out. */
export interface SeoWriteHintRule {
  /** Names the family in an error. */
  readonly name: string;
  readonly hints: (ctx: Ctx, writes: readonly PluginWrite[]) => Promise<readonly string[]>;
}

/** Every hint family, in the order their sentences are shown. */
export const SEO_WRITE_HINT_RULES: readonly SeoWriteHintRule[] = [];

/** Most hints one answer may carry (the SDK's `pluginWriteHints`: five). */
const MAX_HINTS = 5;

const writeHintArgs = z
  .object({
    writes: z.array(
      z.union([
        z
          .object({
            kind: z.literal("module"),
            moduleId: z.string().nullable(),
            html: z.string(),
            fields: z.array(z.record(z.string(), z.unknown())),
          })
          .strict(),
        z
          .object({
            kind: z.literal("values"),
            moduleId: z.string().nullable(),
            values: z.record(z.string(), z.unknown()),
          })
          .strict(),
        // #1758 — a robots rules proposal (core checked the rules).
        z
          .object({
            kind: z.literal("robots_rules"),
            rules: z.array(z.record(z.string(), z.unknown())),
          })
          .strict(),
        // #1757 — an image's alt text, a page's SEO texts.
        z.object({ kind: z.literal("media_alt"), assetId: z.string(), alt: z.string() }).strict(),
        z
          .object({
            kind: z.literal("page_seo"),
            pageId: z.string(),
            seoTitle: z.string().optional(),
            metaDescription: z.string().optional(),
            ogTitle: z.string().optional(),
            ogDescription: z.string().optional(),
          })
          .strict(),
      ]),
    ),
  })
  .strict();

/**
 * The `write_hints` operation: runs {@link SEO_WRITE_HINT_RULES} (or
 * `rules`, for a test) over the writes, each sentence once.
 */
export async function seoWriteHints(
  ctx: Ctx,
  rawArgs: unknown,
  rules: readonly SeoWriteHintRule[] = SEO_WRITE_HINT_RULES,
): Promise<{ hints: string[] }> {
  // The parse checks the kinds and their keys; core built the values (the
  // robots rules it checked with robotsRulesSchema), so the SDK type holds.
  const writes = writeHintArgs.parse(rawArgs).writes as unknown as readonly PluginWrite[];
  const hints: string[] = [];
  for (const rule of rules) {
    for (const hint of await rule.hints(ctx, writes)) {
      if (!hints.includes(hint)) hints.push(hint);
    }
  }
  return { hints: hints.slice(0, MAX_HINTS) };
}
