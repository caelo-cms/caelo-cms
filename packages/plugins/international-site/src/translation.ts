// SPDX-License-Identifier: MPL-2.0

/**
 * Context-aware translation core — the faithful port of the deleted
 * P10 design (git 555c6bfd: shared/translation.ts, ops/translation/
 * mode_1.ts + mode_2.ts) onto the v0.12 content model.
 *
 * NEVER sentence-by-sentence: one AI call carries the WHOLE page —
 * every placement's content fields in render order, plus glossary and
 * per-locale style guide — so terminology, register, and cross-module
 * references stay coherent.
 *
 * What changed against the P10 reference: the translatable unit is a
 * placement's content-instance VALUES (+ the page title), not module
 * HTML — module code is shared across pages in v0.12, so translating
 * it would leak into the source page. The structural lock, the
 * full/update prompt split, the block-aligned diff rendering, and the
 * strict result contract survive unchanged in spirit.
 */

import { z } from "@caelo-cms/plugin-sdk";

export interface ContentSlot {
  blockName: string;
  position: number;
  moduleSlug: string;
  /** Field → value. Only string values are sent for translation;
   *  non-strings (numbers, lists of refs) pass through untouched. */
  values: Record<string, unknown>;
}

export interface GlossaryEntry {
  term: string;
  translation: string;
  context: string | null;
}

export type SlotAlignment =
  | {
      kind: "aligned";
      blockName: string;
      position: number;
      source: ContentSlot;
      variant: ContentSlot;
    }
  | { kind: "added"; blockName: string; position: number; source: ContentSlot }
  | { kind: "removed"; blockName: string; position: number; variant: ContentSlot };

/**
 * Align source and variant slots by (blockName, position) — the §7.5
 * contract: translations share STRUCTURE, differ only in content.
 * `added`/`removed` mark structural drift the translator refuses to
 * apply (the structural lock); realignment is a create_variant re-run.
 */
export function alignSlots(
  source: readonly ContentSlot[],
  variant: readonly ContentSlot[],
): SlotAlignment[] {
  const out: SlotAlignment[] = [];
  const variantBy = new Map<string, ContentSlot>();
  for (const v of variant) variantBy.set(`${v.blockName}|${v.position}`, v);
  const sourceKeys = new Set(source.map((s) => `${s.blockName}|${s.position}`));
  for (const s of source) {
    const v = variantBy.get(`${s.blockName}|${s.position}`);
    if (v) {
      out.push({
        kind: "aligned",
        blockName: s.blockName,
        position: s.position,
        source: s,
        variant: v,
      });
    } else {
      out.push({ kind: "added", blockName: s.blockName, position: s.position, source: s });
    }
  }
  for (const v of variant) {
    if (!sourceKeys.has(`${v.blockName}|${v.position}`)) {
      out.push({ kind: "removed", blockName: v.blockName, position: v.position, variant: v });
    }
  }
  return out;
}

/** The AI's response contract — strict, one entry per translated slot. */
export const translationResultPayload = z
  .object({
    title: z.string().min(1).optional(),
    slots: z.array(
      z
        .object({
          blockName: z.string().min(1),
          position: z.number().int().min(0),
          /** Field → translated string. Only fields present here are
           *  written; untouched fields keep their current value. */
          values: z.record(z.string(), z.string()),
        })
        .strict(),
    ),
  })
  .strict();

export type TranslationResultPayload = z.infer<typeof translationResultPayload>;

function renderGlossaryBlock(glossary: readonly GlossaryEntry[]): string {
  if (glossary.length === 0) return "";
  const lines = glossary.map((g) =>
    g.context
      ? `- "${g.term}" → "${g.translation}" (${g.context})`
      : `- "${g.term}" → "${g.translation}"`,
  );
  return ["", "## Glossary (use these exact translations)", ...lines].join("\n");
}

function renderStyleGuideBlock(styleGuide: string | null): string {
  if (!styleGuide || styleGuide.trim().length === 0) return "";
  return ["", "## Style guide", styleGuide.trim()].join("\n");
}

function renderSlots(slots: readonly ContentSlot[]): string {
  return slots
    .map((s) => {
      const fields = Object.entries(s.values)
        .filter((e): e is [string, string] => typeof e[1] === "string")
        .map(([k, v]) => `${k}:\n\`\`\`\n${v}\n\`\`\``);
      return [
        `### Module ${s.moduleSlug} (block=${s.blockName}, position=${s.position})`,
        ...(fields.length > 0 ? fields : ["(no translatable string fields)"]),
      ].join("\n");
    })
    .join("\n\n");
}

const RESPONSE_CONTRACT =
  'Respond with a JSON object matching: {"title": str (translated page title), "slots": [{"blockName": str, "position": int, "values": {"<field>": "<translated string>", ...}}, ...]}. ' +
  "Include ONLY string fields you translated; preserve every HTML tag, attribute, class, id, href, and inline style inside field values verbatim — only human-readable text is translated. Numbers, code samples, and untranslatable proper nouns stay as-is.";

export interface FullPromptInput {
  sourceLocale: string;
  targetLocale: string;
  targetLocaleDisplayName?: string;
  sourceTitle: string;
  sourceSlots: readonly ContentSlot[];
  glossary: readonly GlossaryEntry[];
  styleGuide: string | null;
}

/** Mode 1 — the whole page in one call. */
export function buildFullTranslationPrompt(input: FullPromptInput): {
  system: string;
  user: string;
} {
  const targetLabel = input.targetLocaleDisplayName ?? input.targetLocale;
  const system = [
    "You are translating a web page from one locale to another.",
    `Source locale: ${input.sourceLocale}.`,
    `Target locale: ${input.targetLocale} (${targetLabel}).`,
    "",
    "STRUCTURAL LOCK — the page's module layout (block names + positions) is identical across locales. You may NOT add, remove, or reorder modules. Translate ONLY the content fields of each existing module, plus the page title.",
    "",
    `${RESPONSE_CONTRACT} Return ONE entry per source module — same blockName + position.`,
    renderGlossaryBlock(input.glossary),
    renderStyleGuideBlock(input.styleGuide),
  ]
    .filter((s) => s.length > 0)
    .join("\n");
  const user = [
    `# Source page (${input.sourceLocale} → ${input.targetLocale})`,
    "",
    `Title: ${input.sourceTitle}`,
    "",
    renderSlots(input.sourceSlots),
  ].join("\n");
  return { system, user };
}

export interface UpdatePromptInput extends FullPromptInput {
  variantTitle: string;
  variantSlots: readonly ContentSlot[];
  alignment: readonly SlotAlignment[];
}

/** Mode 2 — full source + full existing translation + alignment, so
 *  human-polished text survives on slots the model leaves out. */
export function buildUpdateTranslationPrompt(input: UpdatePromptInput): {
  system: string;
  user: string;
} {
  const targetLabel = input.targetLocaleDisplayName ?? input.targetLocale;
  const system = [
    "You are updating an existing translation of a web page after the source changed.",
    `Source locale: ${input.sourceLocale}.`,
    `Target locale: ${input.targetLocale} (${targetLabel}).`,
    "",
    "STRUCTURAL LOCK — the page's module layout (block names + positions) is identical across locales. You may NOT add, remove, or reorder modules. Re-translate ONLY slots whose source content is no longer reflected by the existing translation; preserve the existing translation verbatim everywhere else by OMITTING those slots from your response.",
    "",
    `${RESPONSE_CONTRACT} Return entries ONLY for slots you re-translated — do NOT include unchanged slots.`,
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
    `Title: ${input.sourceTitle}`,
    "",
    renderSlots(input.sourceSlots),
    "",
    "## Existing translation (preserve unchanged slots verbatim)",
    "",
    `Title: ${input.variantTitle}`,
    "",
    renderSlots(input.variantSlots),
    "",
    "## Structural alignment",
  ];
  const added = input.alignment.filter((a) => a.kind === "added");
  const removed = input.alignment.filter((a) => a.kind === "removed");
  if (added.length === 0 && removed.length === 0) {
    userLines.push("(structures are aligned — every slot exists in both languages)");
  }
  for (const a of added) {
    userLines.push(
      `### ADDED in source — block=${a.blockName} position=${a.position} (exists only on the source page; realign via create_variant before translating)`,
    );
  }
  for (const r of removed) {
    userLines.push(
      `### REMOVED from source — block=${r.blockName} position=${r.position} (exists only on the translation)`,
    );
  }
  return { system, user: userLines.join("\n") };
}

/** Tolerate a ```json fence around the model's payload (port of the
 *  mode_1 stripJsonFence). */
export function stripJsonFence(text: string): string {
  const m = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/.exec(text);
  return m?.[1] ?? text;
}

/**
 * Structural-lock validation of a parsed payload.
 * Full mode: exactly one entry per source slot.
 * Update mode: a subset of ALIGNED slots only (added/removed refused).
 */
export function validateStructuralLock(
  payload: TranslationResultPayload,
  alignment: readonly SlotAlignment[],
  mode: "full" | "update",
): void {
  const alignedKeys = new Set(
    alignment.filter((a) => a.kind === "aligned").map((a) => `${a.blockName}|${a.position}`),
  );
  const sourceKeys = new Set(
    alignment
      .filter((a) => a.kind === "aligned" || a.kind === "added")
      .map((a) => `${a.blockName}|${a.position}`),
  );
  const seen = new Set<string>();
  for (const slot of payload.slots) {
    const key = `${slot.blockName}|${slot.position}`;
    if (seen.has(key)) {
      throw new Error(`structural lock: duplicate slot ${key} in the response`);
    }
    seen.add(key);
    if (mode === "update" && !alignedKeys.has(key)) {
      throw new Error(
        `structural lock: response includes slot ${key} which is not aligned between source and translation — refusing to apply`,
      );
    }
    if (mode === "full" && !sourceKeys.has(key)) {
      throw new Error(
        `structural lock: response includes slot ${key} which does not exist on the source page — refusing to apply`,
      );
    }
  }
  if (mode === "full") {
    for (const key of alignedKeys) {
      if (!seen.has(key)) {
        throw new Error(
          `structural lock: response is missing slot ${key} (full mode covers every slot)`,
        );
      }
    }
  }
}
