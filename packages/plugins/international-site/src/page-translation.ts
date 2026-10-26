// SPDX-License-Identifier: MPL-2.0

/**
 * #397 — one context-aware translation pass for a variant page, split at
 * the model call (#741).
 *
 * The whole page goes to the model in ONE call (never sentence by
 * sentence); the structural lock is validated post-hoc; the result lands
 * on the DRAFT variant. #591 — the meta description (og:description) is
 * translated in the same call; writing it back follows core's fill-once
 * rule.
 *
 * Why the split: on the Power-MCP the calling agent does the AI work on
 * its own subscription. {@link preparePageTranslation} computes
 * everything up to the prompt; the install path sends it to `ctx.ai`, a
 * delegated call hands it out as a work item. Either way the answer
 * passes through the same {@link parsePageTranslationAnswer} and
 * {@link writePageTranslation}, so an agent's answer meets exactly the
 * contract the install's own model is held to.
 */

import type { ListTypeDef, PluginAdminQuery, PluginAi } from "@caelo-cms/plugin-sdk";
import { applyStrings, type ChromeField, translatableStrings } from "./chrome.js";
import type { LocaleRow, PageVariantRow } from "./index.js";
import { basisOf } from "./stable-json.js";
import {
  alignSlots,
  buildFullTranslationPrompt,
  buildSlotIndex,
  buildUpdateTranslationPrompt,
  type ContentSlot,
  type GlossaryEntry,
  type SlotAlignment,
  slotKeyOf,
  stripJsonFence,
  type TranslationResultPayload,
  validateMetaDescription,
  validateStructuralLock,
} from "./translation.js";
import {
  type TranslationContract,
  toTranslationPayload,
  translationAnswerSchema,
  translationContractOf,
  translationJsonSchema,
} from "./translation-contract.js";

/** What a page translation needs from the plugin. */
export interface TranslationDeps {
  readonly q: PluginAdminQuery;
  readonly cms: { call: <O>(opName: string, input: unknown) => Promise<O> };
  /** Fresh locale registry (code → row). */
  readonly locales: ReadonlyMap<string, LocaleRow>;
}

export interface GlossaryRow {
  id: string;
  term: string;
  locale_code: string;
  translation: string;
  context: string | null;
}

export interface StyleGuideRow {
  id: string;
  locale_code: string;
  body: string;
}

/**
 * What happened to the variant's meta description (#591): core's
 * fill-once verdict (`pages_seo.apply_translation`), or `untranslated`
 * when the source has none or an update pass left it unchanged.
 */
export type TranslatedSeoOutcome = "filled" | "unchanged" | "marked_stale" | "untranslated";

/** Told to the AI when a live variant's SEO was kept, not overwritten. */
export const SEO_STALE_NEXT_STEP =
  "The variant is live and already had a meta description, so the new translation did not overwrite it (SEO fill-once rule). It is now flagged as stale SEO. If the operator wants the translated description, re-optimize it explicitly with optimize_page_seo (seo-optimize skill).";

/** The next steps a written translation leaves the AI, or undefined. */
export function outcomeNextStep(o: PageTranslationOutcome): string | undefined {
  const steps = [
    ...(o.seo === "marked_stale" ? [SEO_STALE_NEXT_STEP] : []),
    ...(o.sharedNested && o.sharedNested.length > 0
      ? [`${SHARED_NESTED_NEXT_STEP} Placements: ${o.sharedNested.join("; ")}.`]
      : []),
  ];
  return steps.length > 0 ? steps.join(" ") : undefined;
}

/** Everything one page translation is built from, up to the prompt. */
export interface PreparedPageTranslation {
  readonly variantPageId: string;
  readonly variantRowId: string;
  readonly sourceLocale: LocaleRow;
  readonly targetLocale: LocaleRow;
  readonly mode: "full" | "update";
  readonly prompt: { readonly system: string; readonly user: string };
  readonly sourceTitle: string;
  readonly variantTitle: string;
  readonly sourceMetaDescription: string;
  readonly variantMetaDescription: string;
  readonly sourceSlots: readonly ContentSlot[];
  readonly variantSlots: readonly ContentSlot[];
  /** Per slot key: what the write merges into (see {@link SlotBase}). */
  readonly sourceBases: ReadonlyMap<string, SlotBase>;
  readonly variantBases: ReadonlyMap<string, SlotBase>;
  readonly alignment: readonly SlotAlignment[];
  readonly glossary: readonly GlossaryEntry[];
  readonly styleGuide: string | null;
}

/** What a written translation did. */
export interface PageTranslationOutcome {
  mode: "full" | "update";
  slotsApplied: number;
  titleApplied: boolean;
  seo: TranslatedSeoOutcome;
  /**
   * Nested content left untranslated because another page renders the
   * same content instance (a variant created before nested content was
   * copied): writing it would change that page too. Labels like
   * `main #1 > cards[2]`.
   */
  sharedNested?: string[];
}

/** Told to the AI when nested content could not be translated in place. */
export const SHARED_NESTED_NEXT_STEP =
  "Some nested content of this page is still shared with another page (the source page), so it was not translated — writing it would change that page too. Give the page its own copy with fork_placement_content on each listed placement (it copies the nested content), then run translate_variant again.";

/** A module field as `page_module_content.list_for_page` returns it. */
interface PageField extends ChromeField {
  readonly default?: unknown;
}

/** One piece of a page's content as core reads it: a placement or nested content. */
interface ContentRead {
  readonly moduleSlug: string;
  readonly values: Record<string, unknown>;
  readonly fields: readonly PageField[];
}

interface PlacementRead extends ContentRead {
  readonly blockName: string;
  readonly position: number;
  readonly contentInstanceId: string;
  readonly nested: readonly (ContentRead & {
    readonly path: string;
    readonly contentInstanceId: string;
    readonly exclusive: boolean;
  })[];
}

/**
 * What the write needs of one slot beyond its text: the stored values
 * the translation merges into, the fields (for defaults), and — for
 * nested content — the instance and whether only this page renders it.
 */
export interface SlotBase {
  readonly values: Readonly<Record<string, unknown>>;
  readonly fields: readonly PageField[];
  readonly nested?: { readonly contentInstanceId: string; readonly exclusive: boolean };
}

/** A page's content as translation slots, with the bases to write them back. */
export interface PageSlots {
  readonly slots: ContentSlot[];
  readonly bases: Map<string, SlotBase>;
}

/**
 * The values that render: stored values, and the default of every field
 * the content stores no value for. The module extractor turns literal
 * copy (button labels, form labels, menu entries) into such defaults —
 * text a reader of the stored values alone never sees, so it would stay
 * in the source language.
 */
export function effectiveValues(
  fields: readonly PageField[],
  values: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...values };
  for (const f of fields) {
    if (out[f.name] === undefined && f.default !== undefined) {
      out[f.name] = structuredClone(f.default);
    }
  }
  return out;
}

/** The translatable strings of one piece of content, as a slot's path → text. */
function slotTexts(
  content: ContentRead,
  listTypes: ReadonlyMap<string, ListTypeDef>,
): Record<string, unknown> {
  const strings = translatableStrings(
    content.fields,
    effectiveValues(content.fields, content.values),
    // A page's own local lists belong to its translation: list-resolve
    // translates by address only the instances a default-language page
    // shares with other languages (./list-translation-ops.ts).
    { listTypes, includeLists: true },
  );
  const out: Record<string, unknown> = Object.fromEntries(strings.map((t) => [t.path, t.text]));
  // A stored string under a name the module declares no field for (a
  // module authored before field schemas) is offered as text, as it
  // always was; the declared fields say which values are NOT text.
  const declared = new Set(content.fields.map((f) => f.name));
  for (const [k, v] of Object.entries(content.values)) {
    if (!declared.has(k) && typeof v === "string" && v.trim().length > 0) out[k] = v;
  }
  return out;
}

/**
 * Every slot of a page — each placement and each nested content inside
 * it — with the path → text record the translator sees.
 */
export function pageSlotsOf(
  placements: readonly PlacementRead[],
  listTypes: ReadonlyMap<string, ListTypeDef>,
): PageSlots {
  const slots: ContentSlot[] = [];
  const bases = new Map<string, SlotBase>();
  for (const p of placements) {
    const slot: ContentSlot = {
      blockName: p.blockName,
      position: p.position,
      moduleSlug: p.moduleSlug,
      values: slotTexts(p, listTypes),
    };
    slots.push(slot);
    bases.set(slotKeyOf(slot), { values: p.values, fields: p.fields });
    for (const n of p.nested) {
      const nested: ContentSlot = {
        blockName: p.blockName,
        position: p.position,
        nestedPath: n.path,
        moduleSlug: n.moduleSlug,
        values: slotTexts(n, listTypes),
      };
      slots.push(nested);
      bases.set(slotKeyOf(nested), {
        values: n.values,
        fields: n.fields,
        nested: { contentInstanceId: n.contentInstanceId, exclusive: n.exclusive },
      });
    }
  }
  return { slots, bases };
}

async function loadPageSlots(
  deps: TranslationDeps,
  pageId: string,
  listTypes: ReadonlyMap<string, ListTypeDef>,
): Promise<PageSlots> {
  const r = await deps.cms.call<{ placements: PlacementRead[] }>(
    "page_module_content.list_for_page",
    { pageId },
  );
  return pageSlotsOf(r.placements, listTypes);
}

async function loadListTypes(deps: TranslationDeps): Promise<Map<string, ListTypeDef>> {
  const r = await deps.cms.call<{ listTypes: { slug: string; definition: ListTypeDef }[] }>(
    "list_types.list",
    {},
  );
  return new Map(r.listTypes.map((t) => [t.slug, t.definition]));
}

/**
 * The values to write for one slot: the variant's stored values with the
 * translated strings applied. A field the variant stores no value for
 * starts from its default (that is the text the visitor saw). A list
 * field takes the SOURCE's entries — the structure is the source's, the
 * translation only supplies the language — keeping the variant's text of
 * every entry it already has, so an update pass that re-translates one
 * entry leaves the others as they were.
 */
export function translatedValues(
  variant: SlotBase,
  source: SlotBase,
  strings: Readonly<Record<string, string>>,
): Record<string, unknown> {
  const base: Record<string, unknown> = structuredClone({ ...variant.values });
  const sourceValues = effectiveValues(source.fields, source.values);
  const variantValues = effectiveValues(variant.fields, variant.values);
  const touched = new Set(Object.keys(strings).map((p) => p.split("[")[0] as string));
  for (const field of touched) {
    const def = variant.fields.find((f) => f.name === field);
    if (def?.kind === "list") {
      base[field] = keepEntryTexts(sourceValues[field], variantValues[field]);
    } else if (base[field] === undefined) {
      base[field] = structuredClone(variantValues[field]);
    }
  }
  return applyStrings(base, strings);
}

interface Entry {
  id?: unknown;
  values?: Record<string, unknown>;
  children?: unknown;
}

/** `source` list entries with the string values of same-id `variant` entries. */
function keepEntryTexts(source: unknown, variant: unknown): unknown {
  const textsById = new Map<string, Record<string, unknown>>();
  const collect = (items: unknown) => {
    if (!Array.isArray(items)) return;
    for (const raw of items as Entry[]) {
      if (raw && typeof raw.id === "string" && raw.values) textsById.set(raw.id, raw.values);
      collect(raw?.children);
    }
  };
  collect(variant);
  const out = structuredClone(source);
  const apply = (items: unknown) => {
    if (!Array.isArray(items)) return;
    for (const raw of items as Entry[]) {
      const own = raw && typeof raw.id === "string" ? textsById.get(raw.id) : undefined;
      if (own && raw.values) {
        for (const [k, v] of Object.entries(own)) {
          if (typeof v === "string" && typeof raw.values[k] === "string") raw.values[k] = v;
        }
      }
      apply(raw?.children);
    }
  };
  apply(out);
  return out;
}

/** A page's stored meta description; "" when it has none. */
async function loadMetaDescription(deps: TranslationDeps, pageId: string): Promise<string> {
  const r = await deps.cms.call<{ seo: { metaDescription: string } | null }>("pages_seo.get", {
    pageId,
  });
  return r.seo?.metaDescription ?? "";
}

/**
 * Read the variant, its group's source, both pages' content and the
 * target locale's glossary + style guide, resolve the mode, and build the
 * prompt. Read-only.
 *
 * @param args.mode `auto` (or omitted) picks `full` for an untouched
 *   clone and `update` for anything already (partially) translated.
 */
export async function preparePageTranslation(
  deps: TranslationDeps,
  args: { variantPageId: string; mode?: "auto" | "full" | "update" },
): Promise<PreparedPageTranslation> {
  const { q, cms } = deps;
  const variantRows = (await q.list("page_variants", {
    page_id: args.variantPageId,
    limit: 1,
  })) as unknown as PageVariantRow[];
  const variantRow = variantRows[0];
  if (!variantRow) {
    throw new Error(
      `page ${args.variantPageId} is not in a variant group — create_variant / link_page_variants first`,
    );
  }
  const group = (await q.list("page_variants", {
    group_id: variantRow.group_id,
    limit: 100,
  })) as unknown as PageVariantRow[];
  const sourceRow = group.find((v) => v.translation_status === "source");
  if (!sourceRow) {
    throw new Error(
      `variant group ${variantRow.group_id} has no source variant — link the original page first`,
    );
  }
  if (sourceRow.page_id === args.variantPageId) {
    throw new Error("this page IS the source of its group — pick a target variant to translate");
  }
  const sourceLocale = deps.locales.get(sourceRow.locale_code);
  const targetLocale = deps.locales.get(variantRow.locale_code);
  if (!sourceLocale || !targetLocale) {
    throw new Error("group references locales that are no longer registered — fix via set_locales");
  }

  // Page titles via the open read surface.
  const pages = await cms.call<{ pages: { id: string; title: string }[] }>("pages.list", {});
  const sourceTitle = pages.pages.find((p) => p.id === sourceRow.page_id)?.title ?? "";
  const variantTitle = pages.pages.find((p) => p.id === args.variantPageId)?.title ?? "";

  const sourceMetaDescription = await loadMetaDescription(deps, sourceRow.page_id);
  const variantMetaDescription = await loadMetaDescription(deps, args.variantPageId);
  const listTypes = await loadListTypes(deps);
  const source = await loadPageSlots(deps, sourceRow.page_id, listTypes);
  const variant = await loadPageSlots(deps, args.variantPageId, listTypes);
  const sourceSlots = source.slots;
  const variantSlots = variant.slots;
  const alignment = alignSlots(sourceSlots, variantSlots);

  // Glossary + style guide for the TARGET locale.
  const glossaryRows = (await q.list("glossary", {
    locale_code: targetLocale.code,
    limit: 500,
  })) as unknown as GlossaryRow[];
  const glossary: GlossaryEntry[] = glossaryRows.map((g) => ({
    term: g.term,
    translation: g.translation,
    context: g.context,
  }));
  const styleRows = (await q.list("style_guides", {
    locale_code: targetLocale.code,
    limit: 1,
  })) as unknown as StyleGuideRow[];
  const styleGuide = styleRows[0]?.body ?? null;

  // Mode: a fresh clone still carries the source strings verbatim →
  // full; anything already (partially) translated → update, which
  // preserves human polish on slots the model omits.
  let mode: "full" | "update";
  if (args.mode === "full" || args.mode === "update") {
    mode = args.mode;
  } else {
    const untouched = alignment
      .filter((a) => a.kind === "aligned")
      .every(
        (a) =>
          a.kind === "aligned" &&
          JSON.stringify(a.source.values) === JSON.stringify(a.variant.values),
      );
    mode = untouched ? "full" : "update";
  }

  const prompt =
    mode === "full"
      ? buildFullTranslationPrompt({
          sourceLocale: sourceLocale.code,
          targetLocale: targetLocale.code,
          targetLocaleDisplayName: targetLocale.display_name,
          sourceTitle,
          sourceMetaDescription,
          sourceSlots,
          glossary,
          styleGuide,
        })
      : buildUpdateTranslationPrompt({
          sourceLocale: sourceLocale.code,
          targetLocale: targetLocale.code,
          targetLocaleDisplayName: targetLocale.display_name,
          sourceTitle,
          sourceMetaDescription,
          sourceSlots,
          variantTitle,
          variantMetaDescription,
          variantSlots,
          alignment,
          glossary,
          styleGuide,
        });

  return {
    variantPageId: args.variantPageId,
    variantRowId: variantRow.id,
    sourceLocale,
    targetLocale,
    mode,
    prompt,
    sourceTitle,
    variantTitle,
    sourceMetaDescription,
    variantMetaDescription,
    sourceSlots,
    variantSlots,
    sourceBases: source.bases,
    variantBases: variant.bases,
    alignment,
    glossary,
    styleGuide,
  };
}

/**
 * #741 — fingerprint of the content a prepared translation was built
 * from. Both pages' content counts, not just the prompt: in full mode the
 * prompt omits the variant, yet the write merges over its current values
 * and compares its title.
 */
export function pageTranslationBasis(p: PreparedPageTranslation): Promise<string> {
  return basisOf({
    kind: "page",
    variantPageId: p.variantPageId,
    mode: p.mode,
    sourceLocale: p.sourceLocale.code,
    targetLocale: p.targetLocale.code,
    sourceTitle: p.sourceTitle,
    variantTitle: p.variantTitle,
    sourceMetaDescription: p.sourceMetaDescription,
    variantMetaDescription: p.variantMetaDescription,
    sourceSlots: p.sourceSlots,
    variantSlots: p.variantSlots,
    glossary: p.glossary,
    styleGuide: p.styleGuide,
  });
}

/**
 * Parse a model's answer and hold it to the structural lock and the meta
 * description contract. Throws on anything that may not be written.
 *
 * @param answer the raw answer text (a ```json fence is tolerated), or
 *   the JSON value an agent already parsed.
 * @param retryHint the next step named when the answer is not the JSON
 *   the prompt asked for.
 */
export function parsePageTranslationAnswer(
  answer: string | Readonly<Record<string, unknown>>,
  p: PreparedPageTranslation,
  retryHint: string,
): TranslationResultPayload {
  let payload: TranslationResultPayload;
  try {
    payload = toTranslationPayload(
      translationAnswerSchema(pageTranslationContract(p)).parse(
        typeof answer === "string" ? JSON.parse(stripJsonFence(answer)) : answer,
      ),
    );
  } catch (e) {
    throw new Error(
      `translation response did not match the contract: ${(e as Error).message}. ${retryHint}`,
    );
  }
  // The translator answers with opaque slot ids; resolve them back to
  // (blockName, position) against the very index the prompt was built
  // from.
  validateStructuralLock(payload, p.alignment, p.mode, buildSlotIndex(p.sourceSlots));
  validateMetaDescription(payload, p.mode, p.sourceMetaDescription, p.variantMetaDescription);
  return payload;
}

/** The answer contract of a prepared translation — what the prompt
 *  describes and the answer is held to (./translation-contract.ts). */
export function pageTranslationContract(p: PreparedPageTranslation): TranslationContract {
  return translationContractOf({
    mode: p.mode,
    sourceSlots: p.sourceSlots,
    alignment: p.alignment,
    sourceMetaDescription: p.sourceMetaDescription,
    variantMetaDescription: p.variantMetaDescription,
  });
}

/**
 * Write a validated answer onto the DRAFT variant: merge translated
 * strings over the variant's current values (forking synced placements
 * first), update the title, apply the meta description through core's
 * fill-once rule, and mark the variant up to date.
 */
export async function writePageTranslation(
  deps: TranslationDeps,
  p: PreparedPageTranslation,
  payload: TranslationResultPayload,
): Promise<PageTranslationOutcome> {
  const { q, cms } = deps;
  const slotIndex = buildSlotIndex(p.sourceSlots);
  let slotsApplied = 0;
  const answered = payload.slots.flatMap((entry) => {
    const target = slotIndex.get(entry.slot);
    // validateStructuralLock already refused unknown ids.
    return target ? [{ key: slotKeyOf(target), target, strings: entry.values }] : [];
  });
  // Placements first: a synced placement is forked, and the fork copies
  // its nested content — whose new instances the nested writes need.
  let forked = false;
  for (const a of answered.filter((x) => x.target.nestedPath === undefined)) {
    const current = p.variantBases.get(a.key);
    const source = p.sourceBases.get(a.key);
    if (!current || !source) continue; // full-mode 'added' slots have no variant placement — skip
    const contentValues = translatedValues(current, source, a.strings);
    const at = {
      pageId: p.variantPageId,
      blockName: a.target.blockName,
      position: a.target.position,
    };
    try {
      await cms.call("page_module_content.set", { ...at, contentValues });
    } catch (e) {
      const msg = (e as Error).message;
      if (!/synced/i.test(msg)) throw e;
      // A synced placement is shared with other pages — a translation
      // is by definition page-private, so fork first, then write.
      await cms.call("placement.fork_content", at);
      await cms.call("page_module_content.set", { ...at, contentValues });
      forked = true;
    }
    slotsApplied += 1;
  }
  const nestedBases = forked
    ? (await loadPageSlots(deps, p.variantPageId, await loadListTypes(deps))).bases
    : p.variantBases;
  const sharedNested: string[] = [];
  for (const a of answered.filter((x) => x.target.nestedPath !== undefined)) {
    const current = nestedBases.get(a.key);
    const source = p.sourceBases.get(a.key);
    if (!current?.nested || !source) continue;
    if (!current.nested.exclusive) {
      sharedNested.push(`${a.target.blockName} #${a.target.position} > ${a.target.nestedPath}`);
      continue;
    }
    await cms.call("page_module_content.set", {
      pageId: p.variantPageId,
      blockName: a.target.blockName,
      position: a.target.position,
      nestedPath: a.target.nestedPath,
      contentValues: translatedValues(current, source, a.strings),
    });
    slotsApplied += 1;
  }
  let titleApplied = false;
  if (payload.title && payload.title !== p.variantTitle) {
    await cms.call("pages.update", { pageId: p.variantPageId, title: payload.title });
    titleApplied = true;
  }
  let seo: TranslatedSeoOutcome = "untranslated";
  if (payload.metaDescription !== undefined) {
    const applied = await cms.call<{ outcome: "filled" | "unchanged" | "marked_stale" }>(
      "pages_seo.apply_translation",
      { pageId: p.variantPageId, metaDescription: payload.metaDescription },
    );
    seo = applied.outcome;
  }
  // A page with shared nested content is not up to date: part of it is
  // still in the source language.
  if (sharedNested.length === 0) {
    await q.update("page_variants", p.variantRowId, { translation_status: "up_to_date" });
    return { mode: p.mode, slotsApplied, titleApplied, seo };
  }
  return { mode: p.mode, slotsApplied, titleApplied, seo, sharedNested };
}

/**
 * The install-side pass: prepare → the install's AI → write. The answer
 * comes back as SDK structured output constrained to this page's contract
 * (CLAUDE.md §12), so the model cannot offer a key the page has no value
 * for; the Zod + structural-lock checks still run on it.
 */
export async function translateVariantPage(
  deps: TranslationDeps,
  ai: PluginAi,
  args: { variantPageId: string; mode?: "auto" | "full" | "update" },
): Promise<PageTranslationOutcome> {
  const prepared = await preparePageTranslation(deps, args);
  const retryHint =
    "Re-run translate_variant; if this repeats, the page may contain content the model cannot return as JSON.";
  const result = await ai.generateObject({
    system: prepared.prompt.system,
    messages: [{ role: "user", content: prepared.prompt.user }],
    jsonSchema: translationJsonSchema(pageTranslationContract(prepared)),
    maxTokens: 16_000,
    purpose: "translation",
  });
  if (result.object === undefined || result.object === null || typeof result.object !== "object") {
    throw new Error(
      `translation response did not match the contract: the model returned no object that fits the schema. ${retryHint}`,
    );
  }
  const payload = parsePageTranslationAnswer(
    result.object as Readonly<Record<string, unknown>>,
    prepared,
    retryHint,
  );
  return writePageTranslation(deps, prepared, payload);
}
