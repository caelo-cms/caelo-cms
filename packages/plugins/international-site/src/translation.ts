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

import {
  slotIdOf,
  slotKeyOf,
  translationContractOf,
  translationContractText,
} from "./translation-contract.js";

export { slotIdOf, slotKeyOf };

export interface ContentSlot {
  blockName: string;
  position: number;
  /**
   * Nested content inside the placement (a module / module-list value):
   * its path from the placement (`cards[2]`, `hero>cta`). Absent for the
   * placement's own content.
   */
  nestedPath?: string;
  moduleSlug: string;
  /** Path → value. Only string values are sent for translation;
   *  non-strings pass through untouched. A path is a field name, or
   *  `field[<entry id>].<key>` for the text of a local list entry. */
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
      nestedPath?: string;
      source: ContentSlot;
      variant: ContentSlot;
    }
  | {
      kind: "added";
      blockName: string;
      position: number;
      nestedPath?: string;
      source: ContentSlot;
    }
  | {
      kind: "removed";
      blockName: string;
      position: number;
      nestedPath?: string;
      variant: ContentSlot;
    };

/** The nested path of a slot, as an optional property (absent for a placement). */
function nestedOf(s: ContentSlot): { nestedPath?: string } {
  return s.nestedPath === undefined ? {} : { nestedPath: s.nestedPath };
}

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
  for (const v of variant) variantBy.set(slotKeyOf(v), v);
  const sourceKeys = new Set(source.map(slotKeyOf));
  for (const s of source) {
    const v = variantBy.get(slotKeyOf(s));
    const where = { blockName: s.blockName, position: s.position, ...nestedOf(s) };
    if (v) out.push({ kind: "aligned", ...where, source: s, variant: v });
    else out.push({ kind: "added", ...where, source: s });
  }
  for (const v of variant) {
    if (!sourceKeys.has(slotKeyOf(v))) {
      out.push({
        kind: "removed",
        blockName: v.blockName,
        position: v.position,
        ...nestedOf(v),
        variant: v,
      });
    }
  }
  return out;
}

/** Where an offered slot sits: its placement and, for nested content, its path. */
export interface SlotTarget {
  readonly blockName: string;
  readonly position: number;
  readonly nestedPath?: string;
}

/** id → slot target for the slots offered to the translator. */
export function buildSlotIndex(slots: readonly ContentSlot[]): Map<string, SlotTarget> {
  return new Map(
    slots.map((s, i) => [
      slotIdOf(i),
      { blockName: s.blockName, position: s.position, ...nestedOf(s) },
    ]),
  );
}

/**
 * A validated translation answer as the write path applies it: field →
 * translated string per slot; an absent `title` / `metaDescription` means
 * "keep the current one". The wire shape the model answers in, and its
 * per-call schema, live in ./translation-contract.ts.
 */
export interface TranslationResultPayload {
  readonly title?: string;
  /** #1142 — the translated short title (breadcrumb / menu label). */
  readonly shortTitle?: string;
  /** #591 — the translated meta description (also the og:description). */
  readonly metaDescription?: string;
  readonly slots: ReadonlyArray<{
    /** The opaque slot id from the prompt, copied verbatim. */
    readonly slot: string;
    /** Field → translated string. Only fields present here are written;
     *  untouched fields keep their current value. */
    readonly values: Readonly<Record<string, string>>;
  }>;
}

export function renderGlossaryBlock(glossary: readonly GlossaryEntry[]): string {
  if (glossary.length === 0) return "";
  const lines = glossary.map((g) =>
    g.context
      ? `- "${g.term}" → "${g.translation}" (${g.context})`
      : `- "${g.term}" → "${g.translation}"`,
  );
  return ["", "## Glossary (use these exact translations)", ...lines].join("\n");
}

export function renderStyleGuideBlock(styleGuide: string | null): string {
  if (!styleGuide || styleGuide.trim().length === 0) return "";
  return ["", "## Style guide", styleGuide.trim()].join("\n");
}

/**
 * Render slots for the prompt.
 *
 * `idFor` resolves the heading token. Slot ids are always derived from
 * the SOURCE list, and the existing-translation listing in update mode
 * reuses them — numbering that side independently would hand the model
 * two different ids for one slot, which is the same class of ambiguity
 * the opaque id exists to remove.
 */
function renderSlots(
  slots: readonly ContentSlot[],
  idFor: (slot: ContentSlot, index: number) => string | null,
): string {
  return slots
    .map((s, i) => {
      const fields = Object.entries(s.values)
        .filter((e): e is [string, string] => typeof e[1] === "string")
        .map(([k, v]) => `${k}:\n\`\`\`\n${v}\n\`\`\``);
      const id = idFor(s, i);
      // The id leads; the module slug is context only. Anything the
      // model might mistake for an identifier has to come after the
      // one thing it is asked to copy.
      const inside = s.nestedPath === undefined ? "" : `, nested at ${s.nestedPath}`;
      const heading =
        id === null
          ? `### (no slot id — not present on the source page; module ${s.moduleSlug}, block ${s.blockName}${inside})`
          : `### Slot ${id} (module ${s.moduleSlug}, block ${s.blockName}${inside})`;
      return [heading, ...(fields.length > 0 ? fields : ["(no translatable string fields)"])].join(
        "\n",
      );
    })
    .join("\n\n");
}

/** Id resolver for the source listing: plain positional order. */
const bySourceOrder = (_s: ContentSlot, i: number): string => slotIdOf(i);

export interface FullPromptInput {
  sourceLocale: string;
  targetLocale: string;
  targetLocaleDisplayName?: string;
  sourceTitle: string;
  /** #1142 — the source page's short title (its breadcrumb / menu label). */
  sourceShortTitle: string;
  /** The source page's meta description; "" when it has none (#591). */
  sourceMetaDescription: string;
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
    `STRUCTURAL LOCK — the page's module layout (block names + positions) is identical across locales. You may NOT add, remove, or reorder modules. Translate ONLY the content fields of each existing module, plus the page title and its short title (the label in breadcrumbs and menus — keep it as short as the source's)${input.sourceMetaDescription.length > 0 ? " and the meta description (write it as a search-result snippet in the target language, not a word-for-word rendering)" : ""}.`,
    "",
    `${translationContractText(
      translationContractOf({
        mode: "full",
        sourceSlots: input.sourceSlots,
        alignment: [],
        sourceMetaDescription: input.sourceMetaDescription,
        variantMetaDescription: "",
      }),
    )} Return ONE entry per slot listed below.`,
    renderGlossaryBlock(input.glossary),
    renderStyleGuideBlock(input.styleGuide),
  ]
    .filter((s) => s.length > 0)
    .join("\n");
  const user = [
    `# Source page (${input.sourceLocale} → ${input.targetLocale})`,
    "",
    `Title: ${input.sourceTitle}`,
    `Short title: ${input.sourceShortTitle}`,
    ...metaDescriptionLines(input.sourceMetaDescription),
    "",
    renderSlots(input.sourceSlots, bySourceOrder),
  ].join("\n");
  return { system, user };
}

export interface UpdatePromptInput extends FullPromptInput {
  variantTitle: string;
  variantShortTitle: string;
  /** The variant's current meta description; "" when it has none. */
  variantMetaDescription: string;
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
    `STRUCTURAL LOCK — the page's module layout (block names + positions) is identical across locales. You may NOT add, remove, or reorder modules. Re-translate ONLY slots whose source content is no longer reflected by the existing translation; preserve the existing translation verbatim everywhere else by OMITTING those slots from your response.${updateMetaRule(input)}`,
    "",
    `${translationContractText(
      translationContractOf({
        mode: "update",
        sourceSlots: input.sourceSlots,
        alignment: input.alignment,
        sourceMetaDescription: input.sourceMetaDescription,
        variantMetaDescription: input.variantMetaDescription,
      }),
    )} Return entries ONLY for slots you re-translated — do NOT include unchanged slots.`,
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
    `Short title: ${input.sourceShortTitle}`,
    ...metaDescriptionLines(input.sourceMetaDescription),
    "",
    renderSlots(input.sourceSlots, bySourceOrder),
    "",
    "## Existing translation (preserve unchanged slots verbatim)",
    "",
    `Title: ${input.variantTitle}`,
    `Short title: ${input.variantShortTitle}`,
    ...(input.variantMetaDescription.length === 0 && input.sourceMetaDescription.length > 0
      ? ["Meta description: (none yet — translate the source's into metaDescription)"]
      : metaDescriptionLines(input.variantMetaDescription)),
    "",
    renderSlots(input.variantSlots, (slot) => {
      const i = input.sourceSlots.findIndex((src) => slotKeyOf(src) === slotKeyOf(slot));
      return i === -1 ? null : slotIdOf(i);
    }),
    "",
    "## Structural alignment",
  ];
  const added = input.alignment.filter((a) => a.kind === "added");
  const removed = input.alignment.filter((a) => a.kind === "removed");
  if (added.length === 0 && removed.length === 0) {
    userLines.push("(structures are aligned — every slot exists in both languages)");
  }
  const at = (a: SlotAlignment) =>
    `block=${a.blockName} position=${a.position}${a.nestedPath === undefined ? "" : ` nested=${a.nestedPath}`}`;
  for (const a of added) {
    userLines.push(
      `### ADDED in source — ${at(a)} (exists only on the source page; realign via create_variant before translating)`,
    );
  }
  for (const r of removed) {
    userLines.push(`### REMOVED from source — ${at(r)} (exists only on the translation)`);
  }
  return { system, user: userLines.join("\n") };
}

/** The update-mode meta description rule — nothing at all when the
 *  source has no description (the contract has no such key then). */
function updateMetaRule(input: UpdatePromptInput): string {
  if (input.sourceMetaDescription.length === 0) return "";
  if (input.variantMetaDescription.length === 0) {
    return " The translation has no meta description yet: translate the source's.";
  }
  return " The same goes for the meta description: re-translate it only when the existing one no longer reflects the source, otherwise answer null for it.";
}

/** The meta description under the title, fenced like a slot field; no
 *  line at all when the page has none, so the model is not invited to
 *  invent one. */
function metaDescriptionLines(metaDescription: string): string[] {
  if (metaDescription.length === 0) return [];
  return ["Meta description:", "```", metaDescription, "```"];
}

/**
 * #591 — the meta description half of the contract. Full mode must
 * translate a description the source has (a variant without one ships
 * the source language's, or none); a description the source does not
 * have is refused rather than written — it would be invented text.
 * Update mode may omit it (unchanged) — unless the variant has none yet.
 */
export function validateMetaDescription(
  payload: TranslationResultPayload,
  mode: "full" | "update",
  sourceMetaDescription: string,
  variantMetaDescription: string,
): void {
  if (sourceMetaDescription.length === 0) {
    if (payload.metaDescription !== undefined) {
      throw new Error(
        "translation response carries a metaDescription, but the source page has none — refusing to apply invented SEO text",
      );
    }
    return;
  }
  const required = mode === "full" || variantMetaDescription.length === 0;
  if (required && payload.metaDescription === undefined) {
    throw new Error(
      `translation response is missing metaDescription (${mode === "full" ? "full mode translates" : "the variant has none yet, so the update must translate"} the source page's meta description)`,
    );
  }
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
  slotIndex: ReadonlyMap<string, SlotTarget>,
): void {
  const keyOf = (id: string): string | null => {
    const t = slotIndex.get(id);
    return t ? slotKeyOf(t) : null;
  };
  const alignedKeys = new Set(alignment.filter((a) => a.kind === "aligned").map(slotKeyOf));
  const sourceKeys = new Set(
    alignment.filter((a) => a.kind === "aligned" || a.kind === "added").map(slotKeyOf),
  );
  const seen = new Set<string>();
  for (const slot of payload.slots) {
    const key = keyOf(slot.slot);
    if (key === null) {
      throw new Error(
        `structural lock: response uses slot id "${slot.slot}", which was not offered in the prompt (valid ids: ${[...slotIndex.keys()].join(", ")}) — refusing to apply`,
      );
    }
    if (seen.has(key)) {
      throw new Error(`structural lock: duplicate slot ${slot.slot} in the response`);
    }
    seen.add(key);
    if (mode === "update" && !alignedKeys.has(key)) {
      throw new Error(
        `structural lock: response includes slot ${slot.slot} which is not aligned between source and translation — refusing to apply`,
      );
    }
    if (mode === "full" && !sourceKeys.has(key)) {
      throw new Error(
        `structural lock: response includes slot ${slot.slot} which does not exist on the source page — refusing to apply`,
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
