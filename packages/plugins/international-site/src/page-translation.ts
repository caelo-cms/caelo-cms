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

import type { PluginAdminQuery, PluginAi } from "@caelo-cms/plugin-sdk";
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
  stripJsonFence,
  type TranslationResultPayload,
  translationResultPayload,
  validateMetaDescription,
  validateStructuralLock,
} from "./translation.js";

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

async function loadPlacements(deps: TranslationDeps, pageId: string): Promise<ContentSlot[]> {
  const r = await deps.cms.call<{
    placements: {
      blockName: string;
      position: number;
      moduleSlug: string;
      values: Record<string, unknown>;
    }[];
  }>("page_module_content.list_for_page", { pageId });
  return r.placements;
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
  const sourceSlots = await loadPlacements(deps, sourceRow.page_id);
  const variantSlots = await loadPlacements(deps, args.variantPageId);
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
    payload = translationResultPayload.parse(
      typeof answer === "string" ? JSON.parse(stripJsonFence(answer)) : answer,
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
  const variantByKey = new Map(p.variantSlots.map((s) => [`${s.blockName}|${s.position}`, s]));
  let slotsApplied = 0;
  for (const entry of payload.slots) {
    const target = slotIndex.get(entry.slot);
    if (!target) continue; // validateStructuralLock already refused these
    const slot = { ...target, values: entry.values };
    const current = variantByKey.get(`${slot.blockName}|${slot.position}`);
    if (!current) continue; // full-mode 'added' slots have no variant placement — skip
    const merged = { ...current.values, ...slot.values };
    try {
      await cms.call("page_module_content.set", {
        pageId: p.variantPageId,
        blockName: slot.blockName,
        position: slot.position,
        contentValues: merged,
      });
    } catch (e) {
      const msg = (e as Error).message;
      if (!/synced/i.test(msg)) throw e;
      // A synced placement is shared with other pages — a translation
      // is by definition page-private, so fork first, then write.
      await cms.call("placement.fork_content", {
        pageId: p.variantPageId,
        blockName: slot.blockName,
        position: slot.position,
      });
      await cms.call("page_module_content.set", {
        pageId: p.variantPageId,
        blockName: slot.blockName,
        position: slot.position,
        contentValues: merged,
      });
    }
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
  await q.update("page_variants", p.variantRowId, { translation_status: "up_to_date" });
  return { mode: p.mode, slotsApplied, titleApplied, seo };
}

/** The install-side pass: prepare → the install's AI → write. */
export async function translateVariantPage(
  deps: TranslationDeps,
  ai: PluginAi,
  args: { variantPageId: string; mode?: "auto" | "full" | "update" },
): Promise<PageTranslationOutcome> {
  const prepared = await preparePageTranslation(deps, args);
  const result = await ai.complete({
    system: prepared.prompt.system,
    messages: [{ role: "user", content: prepared.prompt.user }],
    maxTokens: 16_000,
    purpose: "translation",
  });
  const payload = parsePageTranslationAnswer(
    result.text,
    prepared,
    "Re-run translate_variant; if this repeats, the page may contain content the model cannot return as JSON.",
  );
  return writePageTranslation(deps, prepared, payload);
}
