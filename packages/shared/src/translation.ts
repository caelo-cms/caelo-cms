// SPDX-License-Identifier: MPL-2.0

/**
 * P10 — translation primitives shared between the AI prompt builder,
 * the Mode 1 / Mode 2 op handlers, and the dashboard.
 *
 *   computeBlockDiff(source, variant) — block-level diff per
 *     CMS_REQUIREMENTS §7.6: matches modules by (block_name, position),
 *     returns typed `changed` / `added` / `removed` operations. Pure
 *     function; the AI receives this as Mode 2 prompt context.
 *
 *   buildModeOnePrompt(...) / buildModeTwoPrompt(...) — assemble the
 *     §7.6 sample-payload shapes with glossary + style guide injected.
 *     Returns the prompt + a structured payload for unit-tests to
 *     assert against.
 */

import { z } from "zod";

export interface ModuleBlockSlot {
  /** The block (e.g. "content", "header") this module sits in. */
  blockName: string;
  /** Position within the block. Blocks are ordered + 0-based. */
  position: number;
  /** Module id — locked across locales (translations share refs). */
  moduleId: string;
  /** Display name shown to the AI for context. */
  moduleSlug: string;
  /** The translatable fields of the module. P10 supports HTML body
   * and three SEO-style metadata fields. Extend as new typed fields
   * land (e.g. structured-content blocks in P12A). */
  html: string;
  altText: string | null;
  caption: string | null;
}

export type BlockDiffOp =
  | {
      kind: "changed";
      blockName: string;
      position: number;
      moduleId: string;
      before: ModuleBlockSlot;
      after: ModuleBlockSlot;
    }
  | { kind: "added"; blockName: string; position: number; module: ModuleBlockSlot }
  | { kind: "removed"; blockName: string; position: number; module: ModuleBlockSlot };

/**
 * Diff a source page's modules against a variant's modules. Match by
 * (blockName, position) — the §7.5 contract is that translations
 * share STRUCTURE with the source (block + position alignment) and
 * differ only in CONTENT (html / alt / caption per locale). Anything
 * mis-aligned is `added` (source has it, variant doesn't) or
 * `removed` (variant has it, source doesn't).
 *
 * `changed` rows contain BOTH before + after so the AI prompt can
 * show the structured diff per the §7.6 sample payload.
 */
export function computeBlockDiff(
  source: readonly ModuleBlockSlot[],
  variant: readonly ModuleBlockSlot[],
): BlockDiffOp[] {
  const ops: BlockDiffOp[] = [];
  const variantBy = new Map<string, ModuleBlockSlot>();
  for (const v of variant) variantBy.set(`${v.blockName}|${v.position}`, v);
  const sourceBy = new Map<string, ModuleBlockSlot>();
  for (const s of source) sourceBy.set(`${s.blockName}|${s.position}`, s);

  for (const s of source) {
    const key = `${s.blockName}|${s.position}`;
    const v = variantBy.get(key);
    if (!v) {
      ops.push({ kind: "added", blockName: s.blockName, position: s.position, module: s });
      continue;
    }
    if (s.html !== v.html || s.altText !== v.altText || s.caption !== v.caption) {
      ops.push({
        kind: "changed",
        blockName: s.blockName,
        position: s.position,
        moduleId: v.moduleId,
        before: v,
        after: s,
      });
    }
  }
  for (const v of variant) {
    const key = `${v.blockName}|${v.position}`;
    if (!sourceBy.has(key)) {
      ops.push({ kind: "removed", blockName: v.blockName, position: v.position, module: v });
    }
  }
  return ops;
}

// ---------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------

export interface GlossaryEntry {
  sourceTerm: string;
  translation: string;
  context: string | null;
}

export interface ModeOnePromptInput {
  /** Source-locale code (e.g. 'en'). */
  sourceLocale: string;
  /** Target locale code (e.g. 'de-AT'). */
  targetLocale: string;
  /** Optional locale displayName for context (e.g. "German (Austria)"). */
  targetLocaleDisplayName?: string;
  /** Source-page modules. The AI translates each per (blockName, position). */
  sourceModules: readonly ModuleBlockSlot[];
  glossary: readonly GlossaryEntry[];
  styleGuide: string | null;
}

export interface ModeTwoPromptInput {
  sourceLocale: string;
  targetLocale: string;
  targetLocaleDisplayName?: string;
  sourceModules: readonly ModuleBlockSlot[];
  /** The CURRENT variant — passed in full so the AI keeps the prior
   * translation quality on unchanged blocks. */
  variantModules: readonly ModuleBlockSlot[];
  /** Pre-computed diff (call computeBlockDiff first). */
  diff: readonly BlockDiffOp[];
  glossary: readonly GlossaryEntry[];
  styleGuide: string | null;
}

/**
 * The AI returns this shape for both Mode 1 and Mode 2: one entry per
 * source module slot, with the translated content fields. The handler
 * matches entries back to the variant page's module rows by
 * (blockName, position).
 *
 * Mode 1 returns one entry per source module.
 * Mode 2 returns entries ONLY for changed blocks (preserves prior
 *   translation on unchanged ones).
 */
export const translationResultModule = z
  .object({
    blockName: z.string().min(1),
    position: z.number().int().min(0),
    /** Translated module HTML body. */
    html: z.string(),
    altText: z.string().nullable().optional(),
    caption: z.string().nullable().optional(),
  })
  .strict();

export const translationResultPayload = z
  .object({
    modules: z.array(translationResultModule),
  })
  .strict();
export type TranslationResultPayload = z.infer<typeof translationResultPayload>;

function renderGlossaryBlock(glossary: readonly GlossaryEntry[]): string {
  if (glossary.length === 0) return "";
  const lines = glossary.map((g) =>
    g.context
      ? `- "${g.sourceTerm}" → "${g.translation}" (${g.context})`
      : `- "${g.sourceTerm}" → "${g.translation}"`,
  );
  return ["", "## Glossary (use these exact translations)", ...lines].join("\n");
}

function renderStyleGuideBlock(styleGuide: string | null): string {
  if (!styleGuide || styleGuide.trim().length === 0) return "";
  return ["", "## Style guide", styleGuide.trim()].join("\n");
}

function renderSourceModulesBlock(modules: readonly ModuleBlockSlot[]): string {
  const rendered = modules.map((m) => {
    const parts = [
      `### Module ${m.moduleSlug} (block=${m.blockName}, position=${m.position})`,
      "HTML:",
      "```html",
      m.html,
      "```",
    ];
    if (m.altText !== null) parts.push(`alt: ${m.altText}`);
    if (m.caption !== null) parts.push(`caption: ${m.caption}`);
    return parts.join("\n");
  });
  return rendered.join("\n\n");
}

export function buildModeOnePrompt(input: ModeOnePromptInput): {
  system: string;
  user: string;
} {
  const targetLabel = input.targetLocaleDisplayName ?? input.targetLocale;
  const system = [
    "You are translating a web page from one locale to another.",
    `Source locale: ${input.sourceLocale}.`,
    `Target locale: ${input.targetLocale} (${targetLabel}).`,
    "",
    "STRUCTURAL LOCK — the page's module layout (block names + positions) is identical across locales. You may NOT add, remove, or reorder modules. Translate ONLY the content fields (html, alt, caption) of each existing module.",
    "",
    "Translate every module listed below into the target locale. Preserve every HTML tag, attribute, class, id, href, and inline style verbatim — only the human-readable text inside tags + the alt/caption fields are translated. Numbers, code samples, and untranslatable proper nouns stay as-is.",
    "",
    'Respond with a JSON object matching: {"modules": [{"blockName": str, "position": int, "html": str, "altText": str|null, "caption": str|null}, ...]}. Return ONE entry per source module — same blockName + position.',
    renderGlossaryBlock(input.glossary),
    renderStyleGuideBlock(input.styleGuide),
  ]
    .filter((s) => s.length > 0)
    .join("\n");
  const user = [
    `# Source page modules (${input.sourceLocale} → ${input.targetLocale})`,
    "",
    renderSourceModulesBlock(input.sourceModules),
  ].join("\n");
  return { system, user };
}

export function buildModeTwoPrompt(input: ModeTwoPromptInput): {
  system: string;
  user: string;
} {
  const targetLabel = input.targetLocaleDisplayName ?? input.targetLocale;
  const changed = input.diff.filter((d) => d.kind === "changed");
  const added = input.diff.filter((d) => d.kind === "added");
  const removed = input.diff.filter((d) => d.kind === "removed");

  const system = [
    "You are updating an existing translation of a web page after the source changed.",
    `Source locale: ${input.sourceLocale}.`,
    `Target locale: ${input.targetLocale} (${targetLabel}).`,
    "",
    "STRUCTURAL LOCK — the page's module layout (block names + positions) is identical across locales. You may NOT add, remove, or reorder modules. Translate ONLY the content fields (html, alt, caption) that have CHANGED on the source. Preserve the existing translation verbatim for unchanged modules.",
    "",
    "Numbers, code samples, and untranslatable proper nouns stay as-is. Preserve every HTML tag/attribute/class/id/href/inline style in the source verbatim.",
    "",
    'Respond with a JSON object matching: {"modules": [{"blockName": str, "position": int, "html": str, "altText": str|null, "caption": str|null}, ...]}. Return ONE entry per CHANGED module — do NOT include unchanged modules in the response.',
    renderGlossaryBlock(input.glossary),
    renderStyleGuideBlock(input.styleGuide),
  ]
    .filter((s) => s.length > 0)
    .join("\n");

  const userLines: string[] = [
    `# Update translation: ${input.sourceLocale} → ${input.targetLocale}`,
    "",
    "## Current source (full, for context)",
    "",
    renderSourceModulesBlock(input.sourceModules),
    "",
    "## Existing translation (preserve unchanged modules verbatim)",
    "",
    renderSourceModulesBlock(input.variantModules),
    "",
    "## Structured diff",
  ];
  if (changed.length === 0 && added.length === 0 && removed.length === 0) {
    userLines.push("(no changes detected — return an empty `modules` array)");
  }
  for (const c of changed) {
    if (c.kind !== "changed") continue;
    userLines.push("");
    userLines.push(
      `### CHANGED — block=${c.blockName} position=${c.position} module=${c.moduleId}`,
    );
    userLines.push("Before (existing translation):");
    userLines.push("```html");
    userLines.push(c.before.html);
    userLines.push("```");
    userLines.push("Source after (current source HTML to re-translate):");
    userLines.push("```html");
    userLines.push(c.after.html);
    userLines.push("```");
  }
  for (const a of added) {
    if (a.kind !== "added") continue;
    userLines.push("");
    userLines.push(
      `### ADDED in source — block=${a.blockName} position=${a.position} (must translate)`,
    );
    userLines.push("```html");
    userLines.push(a.module.html);
    userLines.push("```");
  }
  for (const r of removed) {
    if (r.kind !== "removed") continue;
    userLines.push("");
    userLines.push(
      `### REMOVED from source — block=${r.blockName} position=${r.position} (drop from the translation)`,
    );
  }
  return { system, user: userLines.join("\n") };
}
