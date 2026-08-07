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

/**
 * The identifier the translator echoes back, and the ONLY one it sees.
 *
 * A slot is really (blockName, position), but asking the model to
 * reproduce two fields alongside a third it must not use (moduleSlug)
 * invites exactly one mistake: a live run returned the module slug as
 * the block name, the structural lock refused the whole translation,
 * and the AI fell back to translating by hand. An opaque positional id
 * removes the choice — there is one token, it is meaningless on its
 * own, and copying it is the only thing that can be done with it.
 *
 * Derived from the SOURCE order, so ids are stable within one call.
 */
export function slotIdOf(index: number): string {
  return `s${index}`;
}

/** id → (blockName, position) for the slots offered to the translator. */
export function buildSlotIndex(
  slots: readonly ContentSlot[],
): Map<string, { blockName: string; position: number }> {
  return new Map(
    slots.map((s, i) => [slotIdOf(i), { blockName: s.blockName, position: s.position }]),
  );
}

/** The AI's response contract — strict, one entry per translated slot. */
export const translationResultPayload = z
  .object({
    title: z.string().min(1).optional(),
    slots: z.array(
      z
        .object({
          /** The opaque slot id from the prompt, copied verbatim. */
          slot: z.string().min(1),
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
      const heading =
        id === null
          ? `### (no slot id — not present on the source page; module ${s.moduleSlug}, block ${s.blockName})`
          : `### Slot ${id} (module ${s.moduleSlug}, block ${s.blockName})`;
      return [heading, ...(fields.length > 0 ? fields : ["(no translatable string fields)"])].join(
        "\n",
      );
    })
    .join("\n\n");
}

/** Id resolver for the source listing: plain positional order. */
const bySourceOrder = (_s: ContentSlot, i: number): string => slotIdOf(i);

const RESPONSE_CONTRACT =
  'Respond with a JSON object matching: {"title": str (translated page title), "slots": [{"slot": "<the slot id from the heading, copied EXACTLY — e.g. s0>", "values": {"<field>": "<translated string>", ...}}, ...]}. ' +
  'Never invent a slot id and never substitute the module slug or block name for it — copy the "### Slot <id>" token verbatim. ' +
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
    `${RESPONSE_CONTRACT} Return ONE entry per slot listed below.`,
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
    renderSlots(input.sourceSlots, bySourceOrder),
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
    renderSlots(input.sourceSlots, bySourceOrder),
    "",
    "## Existing translation (preserve unchanged slots verbatim)",
    "",
    `Title: ${input.variantTitle}`,
    "",
    renderSlots(input.variantSlots, (slot) => {
      const i = input.sourceSlots.findIndex(
        (src) => src.blockName === slot.blockName && src.position === slot.position,
      );
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
  slotIndex: ReadonlyMap<string, { blockName: string; position: number }>,
): void {
  const keyOf = (id: string): string | null => {
    const t = slotIndex.get(id);
    return t ? `${t.blockName}|${t.position}` : null;
  };
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
