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
import { basisOf, stableJson } from "./stable-json.js";
import {
  alignSlots,
  buildFullTranslationPrompt,
  buildSlotIndex,
  buildUpdateTranslationPrompt,
  type ContentSlot,
  type GlossaryEntry,
  type SlotAlignment,
  type SlotTarget,
  slotKeyOf,
  stripJsonFence,
  type TranslationResultPayload,
  validateMetaDescription,
  validateStructuralLock,
  variantSlotsBySource,
} from "./translation.js";
import {
  type TranslationContract,
  toTranslationPayload,
  translationAnswerSchema,
  translationContractOf,
  translationJsonSchema,
} from "./translation-contract.js";

/** Ids of one bulk read: what `anyOf` and `rendered_on_many` take at most. */
const READ_BATCH = 1000;

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
  "The variant is live and already had a meta description, so the new translation did not overwrite it (SEO fill-once rule). It is now flagged as stale SEO. If the operator wants the translated description, re-optimize it explicitly with bulk_optimize_seo (page-seo skill).";

/** The next step a written translation leaves the AI, or undefined. */
export function outcomeNextStep(o: PageTranslationOutcome): string | undefined {
  return o.seo === "marked_stale" ? SEO_STALE_NEXT_STEP : undefined;
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
  readonly sourceShortTitle: string;
  readonly variantShortTitle: string;
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
}

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
  })[];
}

/**
 * What the write needs of one slot beyond its text: the stored values
 * the translation merges into, the fields (for defaults), and the
 * instance that holds them.
 */
export interface SlotBase {
  readonly values: Readonly<Record<string, unknown>>;
  readonly fields: readonly PageField[];
  readonly contentInstanceId: string;
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
    bases.set(slotKeyOf(slot), {
      values: p.values,
      fields: p.fields,
      contentInstanceId: p.contentInstanceId,
    });
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
        contentInstanceId: n.contentInstanceId,
      });
    }
  }
  return { slots, bases };
}

async function loadPageSlots(
  deps: Pick<TranslationDeps, "cms">,
  pageId: string,
  listTypes: ReadonlyMap<string, ListTypeDef>,
): Promise<PageSlots> {
  const r = await deps.cms.call<{ placements: PlacementRead[] }>(
    "page_module_content.list_for_page",
    { pageId },
  );
  return pageSlotsOf(r.placements, listTypes);
}

async function loadListTypes(
  deps: Pick<TranslationDeps, "cms">,
): Promise<Map<string, ListTypeDef>> {
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
async function loadMetaDescription(
  deps: Pick<TranslationDeps, "cms">,
  pageId: string,
): Promise<string> {
  const r = await deps.cms.call<{ seo: { metaDescription: string } | null }>("pages_seo.get", {
    pageId,
  });
  return r.seo?.metaDescription ?? "";
}

/**
 * #1267 — the source content a page translation is made from. A variant's
 * `source_hash` is its fingerprint at the moment the variant became up to
 * date, so whether the source changed since is decided from the content
 * alone: a rebuild of translation staleness (a fresh activation, a cursor
 * behind the journal's horizon) flags exactly the variants whose source
 * differs, not every one.
 */
export interface PageSource {
  readonly title: string;
  readonly shortTitle: string;
  readonly metaDescription: string;
  readonly slots: readonly ContentSlot[];
}

/** Fingerprint of a page's translatable source content ({@link PageSource}). */
export function pageSourceFingerprint(src: PageSource): Promise<string> {
  return basisOf({
    kind: "page-source",
    title: src.title,
    shortTitle: src.shortTitle,
    metaDescription: src.metaDescription,
    slots: src.slots,
  });
}

/**
 * The fingerprint a variant adopts when its source only GAINED a meta
 * description after the translation, or null when the variant is out of
 * date.
 *
 * A variant translated while its source had no meta description carries
 * none from the translation; its own is filled independently (the SEO
 * autofill fills every page of a first Stage, the variant in its own
 * language). The source's first meta description is then nothing the
 * variant lacks, so flagging it would send the operator to re-translate a
 * page that is complete. Adopting the current fingerprint keeps every later
 * change — a meta description edit included — comparable.
 *
 * @param args.storedHash the variant's `source_hash` (an exact one; a
 *   backfilled hash is no basis, see BACKFILLED_HASH in index.ts).
 * @returns the source's current fingerprint to store, or null.
 */
export async function adoptedAfterSourceMetaFill(
  deps: Pick<TranslationDeps, "cms">,
  args: { storedHash: string | null; source: PageSource; variantPageId: string },
): Promise<string | null> {
  if (args.storedHash === null || args.source.metaDescription === "") return null;
  const beforeFill = await pageSourceFingerprint({ ...args.source, metaDescription: "" });
  if (args.storedHash !== beforeFill) return null;
  if ((await loadMetaDescription(deps, args.variantPageId)) === "") return null;
  return pageSourceFingerprint(args.source);
}

/**
 * Read a page's {@link PageSource} as a translation pass reads it.
 *
 * @returns null when the page is deleted (a soft delete keeps its variant
 *   linkage, and an undo brings it back): a deleted source is no basis to
 *   compare a translation with, so callers leave its variants as they are.
 */
export async function loadPageSource(
  deps: Pick<TranslationDeps, "cms">,
  pageId: string,
  listTypes: ReadonlyMap<string, ListTypeDef>,
): Promise<PageSource | null> {
  const listed = await deps.cms.call<{
    pages: { id: string; title: string; shortTitle: string }[];
  }>("pages.list", { pageIds: [pageId] });
  const page = listed.pages.find((p) => p.id === pageId);
  if (!page) return null;
  const metaDescription = await loadMetaDescription(deps, pageId);
  const { slots } = await loadPageSlots(deps, pageId, listTypes);
  return { title: page.title, shortTitle: page.shortTitle, metaDescription, slots };
}

/**
 * The current fingerprint of a source page, for a variant that becomes up
 * to date without a translation pass (linking an existing page).
 */
export async function currentSourceFingerprint(
  deps: Pick<TranslationDeps, "cms">,
  sourcePageId: string,
): Promise<string> {
  const listTypes = await loadListTypes(deps);
  const source = await loadPageSource(deps, sourcePageId, listTypes);
  if (!source) {
    throw new Error(
      `the source page ${sourcePageId} of this variant group is deleted — restore it (undo) or link the page into another group`,
    );
  }
  return pageSourceFingerprint(source);
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
  const pages = await cms.call<{ pages: { id: string; title: string; shortTitle: string }[] }>(
    "pages.list",
    {},
  );
  const sourcePage = pages.pages.find((p) => p.id === sourceRow.page_id);
  const variantPage = pages.pages.find((p) => p.id === args.variantPageId);
  const sourceTitle = sourcePage?.title ?? "";
  const variantTitle = variantPage?.title ?? "";
  const sourceShortTitle = sourcePage?.shortTitle ?? "";
  const variantShortTitle = variantPage?.shortTitle ?? "";

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
          sourceShortTitle,
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
          sourceShortTitle,
          sourceMetaDescription,
          sourceSlots,
          variantTitle,
          variantShortTitle,
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
    sourceShortTitle,
    variantShortTitle,
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
    sourceShortTitle: p.sourceShortTitle,
    variantShortTitle: p.variantShortTitle,
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

/** One answered slot whose text differs from what the variant stores. */
interface SlotChange {
  readonly source: SlotBase;
  readonly variant: ContentSlot;
  readonly variantKey: string;
  readonly strings: Readonly<Record<string, string>>;
}

/**
 * Whether writing `strings` changes what `variant` renders. An answer
 * that repeats the current text is no change: writing it would snapshot
 * nothing, and copying content for it would end its sharing for nothing.
 */
function changesContent(
  variant: SlotBase,
  source: SlotBase,
  strings: Readonly<Record<string, string>>,
): boolean {
  const next = translatedValues(variant, source, strings);
  return (
    stableJson(effectiveValues(variant.fields, next)) !==
    stableJson(effectiveValues(variant.fields, variant.values))
  );
}

/** The slots from a slot's placement down to the slot itself. */
function chainOf(slot: ContentSlot): SlotTarget[] {
  const at = { blockName: slot.blockName, position: slot.position };
  const chain: SlotTarget[] = [at];
  let path = "";
  for (const step of slot.nestedPath?.split(">") ?? []) {
    path = path === "" ? step : `${path}>${step}`;
    chain.push({ ...at, nestedPath: path });
  }
  return chain;
}

/** The language of each page: its variant's, the default for a page in no group. */
async function languagesOf(
  deps: Pick<TranslationDeps, "q" | "locales">,
  pageIds: readonly string[],
): Promise<(pageId: string) => string | null> {
  const defaultCode = [...deps.locales.values()].find((l) => l.is_default)?.code ?? null;
  const byPage = new Map<string, string>();
  for (let i = 0; i < pageIds.length; i += READ_BATCH) {
    const rows = (await deps.q.list("page_variants", {
      anyOf: { page_id: pageIds.slice(i, i + READ_BATCH) },
      limit: READ_BATCH,
    })) as unknown as PageVariantRow[];
    for (const r of rows) byPage.set(r.page_id, r.locale_code);
  }
  return (pageId) => byPage.get(pageId) ?? defaultCode;
}

/**
 * What a translation may change in place, and what it must copy.
 *
 * Pages of one language share content on purpose (a tool's data on two
 * comparison pages), and a translation of that language belongs in the
 * shared instance. Content another language renders, the source above all,
 * must not change: it gets a copy. So the line runs between languages, not
 * between pages (#1453). What renders in chrome or a shared list counts as
 * every language's.
 *
 * @returns `copied`: the instances of the changed chains to copy;
 *   `otherPages`: the pages of the target language those chains render on,
 *   which core checks every in-place write against.
 */
async function sharingOf(
  deps: TranslationDeps,
  p: PreparedPageTranslation,
  changes: readonly SlotChange[],
): Promise<{ copied: ReadonlySet<string>; otherPages: readonly string[] }> {
  const ids = new Set<string>();
  for (const c of changes) {
    for (const link of chainOf(c.variant)) {
      const id = p.variantBases.get(slotKeyOf(link))?.contentInstanceId;
      if (id !== undefined) ids.add(id);
    }
  }
  if (ids.size === 0) return { copied: new Set(), otherPages: [] };
  const instances: { id: string; pageIds: string[]; siteWide: boolean }[] = [];
  const idList = [...ids];
  for (let i = 0; i < idList.length; i += READ_BATCH) {
    const read = await deps.cms.call<{ instances: typeof instances }>(
      "content_instances.rendered_on_many",
      { ids: idList.slice(i, i + READ_BATCH) },
    );
    instances.push(...read.instances);
  }
  const pages = [...new Set(instances.flatMap((i) => i.pageIds))].filter(
    (id) => id !== p.variantPageId,
  );
  const languageOf = await languagesOf(deps, pages);
  const target = p.targetLocale.code;
  const copied = instances
    .filter(
      (i) =>
        i.siteWide || i.pageIds.some((id) => id !== p.variantPageId && languageOf(id) !== target),
    )
    .map((i) => i.id);
  return {
    copied: new Set(copied),
    otherPages: pages.filter((id) => languageOf(id) === target),
  };
}

/**
 * Write a validated answer onto the DRAFT variant: merge translated
 * strings over the variant's current values, update the title, apply the
 * meta description through core's fill-once rule, and mark the variant up
 * to date.
 *
 * Every slot is written where its ALIGNED variant slot sits (identity,
 * not position: a variant with its sections in another order gets each
 * text in its own section). Only slots whose text changes are written, so
 * unchanged content keeps its instance whatever it is shared with.
 *
 * A write never changes what another language renders (#1309), and never
 * ends sharing inside the target language (#1453): {@link sharingOf} draws
 * that line, the instances on the far side of it are copied one by one
 * (`placement.fork_paths`, with every instance above them that is on the
 * far side too), and the writes land in the instances the variant holds
 * then. Core refuses a write that reaches any page not named to it.
 */
export async function writePageTranslation(
  deps: TranslationDeps,
  p: PreparedPageTranslation,
  payload: TranslationResultPayload,
): Promise<PageTranslationOutcome> {
  const { q, cms } = deps;
  const slotIndex = buildSlotIndex(p.sourceSlots);
  const variantOf = variantSlotsBySource(p.alignment);
  const changes = payload.slots.flatMap((entry): SlotChange[] => {
    const target = slotIndex.get(entry.slot);
    // validateStructuralLock already refused unknown ids.
    if (!target) return [];
    const key = slotKeyOf(target);
    // Full-mode 'added' slots have no variant counterpart: nothing to write.
    const variant = variantOf.get(key);
    const source = p.sourceBases.get(key);
    if (!variant || !source) return [];
    const variantKey = slotKeyOf(variant);
    const current = p.variantBases.get(variantKey);
    if (!current || !changesContent(current, source, entry.values)) return [];
    return [{ source, variant, variantKey, strings: entry.values }];
  });

  const { copied, otherPages } = await sharingOf(deps, p, changes);
  const forks = new Map<string, { root: boolean; nestedPaths: Set<string>; slot: ContentSlot }>();
  for (const c of changes) {
    for (const link of chainOf(c.variant)) {
      const id = p.variantBases.get(slotKeyOf(link))?.contentInstanceId;
      if (id === undefined || !copied.has(id)) continue;
      const key = `${link.blockName}|${link.position}`;
      const fork = forks.get(key) ?? { root: false, nestedPaths: new Set(), slot: c.variant };
      if (link.nestedPath === undefined) fork.root = true;
      else fork.nestedPaths.add(link.nestedPath);
      forks.set(key, fork);
    }
  }
  const placementOf = (v: ContentSlot) => ({
    pageId: p.variantPageId,
    blockName: v.blockName,
    position: v.position,
  });
  for (const fork of forks.values()) {
    await cms.call("placement.fork_paths", {
      ...placementOf(fork.slot),
      root: fork.root,
      nestedPaths: [...fork.nestedPaths],
      alsoChangesPages: otherPages,
    });
  }
  // A copy changes the references in the values above it, so the bases
  // are read back BEFORE anything is written over them: writing the
  // prepared values would point the variant back at what it just left.
  const bases =
    forks.size === 0
      ? p.variantBases
      : (await loadPageSlots(deps, p.variantPageId, await loadListTypes(deps))).bases;
  // Two slots can show one instance, and a write replaces its values: the
  // slots' texts are merged per instance, or the later would undo the
  // earlier.
  const writes = new Map<string, { slot: ContentSlot; values: Record<string, unknown> }>();
  for (const c of changes) {
    const current = bases.get(c.variantKey);
    if (!current) throw new Error(`slot ${c.variantKey} vanished from the variant`);
    const earlier = writes.get(current.contentInstanceId);
    writes.set(current.contentInstanceId, {
      slot: earlier?.slot ?? c.variant,
      values: translatedValues(
        earlier ? { ...current, values: earlier.values } : current,
        c.source,
        c.strings,
      ),
    });
  }
  for (const { slot, values } of writes.values()) {
    await cms.call("page_module_content.set", {
      ...placementOf(slot),
      ...(slot.nestedPath === undefined ? {} : { nestedPath: slot.nestedPath }),
      contentValues: values,
      alsoChangesPages: otherPages,
    });
  }
  const slotsApplied = changes.length;
  let titleApplied = false;
  const title = payload.title && payload.title !== p.variantTitle ? payload.title : undefined;
  const shortTitle =
    payload.shortTitle && payload.shortTitle !== p.variantShortTitle
      ? payload.shortTitle
      : undefined;
  if (title !== undefined || shortTitle !== undefined) {
    await cms.call("pages.update", {
      pageId: p.variantPageId,
      ...(title !== undefined ? { title } : {}),
      ...(shortTitle !== undefined ? { shortTitle } : {}),
    });
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
  // The source this translation was made from: a source edit after the
  // prepare step leaves the hash behind, so the variant reads as stale.
  const sourceHash = await pageSourceFingerprint({
    title: p.sourceTitle,
    shortTitle: p.sourceShortTitle,
    metaDescription: p.sourceMetaDescription,
    slots: p.sourceSlots,
  });
  await q.update("page_variants", p.variantRowId, {
    translation_status: "up_to_date",
    source_hash: sourceHash,
  });
  return { mode: p.mode, slotsApplied, titleApplied, seo };
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
