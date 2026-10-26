// SPDX-License-Identifier: MPL-2.0

/**
 * #592 — per-locale site chrome, the I/O half: the content-variants
 * resolver core calls while rendering, the translation flow, the
 * detach/re-attach writes and the staleness refresh. Pure helpers live
 * in ./chrome.ts; see its header for the model.
 */

import type {
  ContentVariantPage,
  ListTypeDef,
  PluginAdminQuery,
  PluginAi,
} from "@caelo-cms/plugin-sdk";
import { z } from "@caelo-cms/plugin-sdk";
import {
  applyStrings,
  buildChromeTranslationPrompt,
  type ChromeField,
  type ChromeListContext,
  type ChromeTranslationPayload,
  type ChromeTranslationTarget,
  chromeTranslationJsonSchema,
  chromeTranslationPayload,
  instanceTargetKey,
  layoutTargetKey,
  sourceFingerprint,
  translatableStrings,
  validateChromeTranslation,
} from "./chrome.js";
import type { LocaleRow } from "./index.js";
import type { SourceUnit } from "./list-translation.js";
import {
  checkListTranslations,
  type ListTranslationState,
  listWorkTargets,
  loadListTranslationState,
  writeListTranslations,
} from "./list-translation-ops.js";
import { basisOf } from "./stable-json.js";
import {
  type GlossaryEntry,
  renderGlossaryBlock,
  renderStyleGuideBlock,
  stripJsonFence,
} from "./translation.js";

/** Core handle as the plugin uses it. */
export interface ChromeCms {
  call: <O>(opName: string, input: unknown) => Promise<O>;
}

/** What the chrome operations need from the plugin. */
export interface ChromeDeps {
  readonly q: PluginAdminQuery;
  readonly cms: ChromeCms;
  /** Fresh locale registry (code → row). */
  readonly locales: ReadonlyMap<string, LocaleRow>;
  /** The site's list types by slug (`list_types.list`), for local lists in chrome. */
  readonly listTypes: ReadonlyMap<string, ListTypeDef>;
}

/**
 * Which local lists a chrome target translates itself: a layout
 * placement's (module defaults have no value address); a shared
 * instance's go through the list-resolve overlay instead (chrome.ts).
 */
export function chromeListContext(
  deps: Pick<ChromeDeps, "listTypes">,
  kind: "layout" | "instance",
): ChromeListContext {
  return { listTypes: deps.listTypes, includeLists: kind === "layout" };
}

/**
 * The part of a target's content its chrome variant derives from: an
 * instance's local lists are translated by address, so they neither make
 * the variant stale nor are they copied into it.
 */
export function chromeSource(target: {
  readonly kind: "layout" | "instance";
  readonly fields: readonly ChromeField[];
  readonly values: Readonly<Record<string, unknown>>;
}): { fields: ChromeField[]; values: Record<string, unknown> } {
  if (target.kind === "layout") return { fields: [...target.fields], values: { ...target.values } };
  const lists = new Set(
    target.fields
      .filter((f) => f.kind === "list" && (f.bind ?? "local") === "local")
      .map((f) => f.name),
  );
  return {
    fields: target.fields.filter((f) => !lists.has(f.name)),
    values: Object.fromEntries(Object.entries(target.values).filter(([k]) => !lists.has(k))),
  };
}

/** A stored locale variant of one chrome target. */
export interface ChromeVariantRow {
  id: string;
  target_key: string;
  locale_code: string;
  mode: "translated" | "independent";
  module_id: string | null;
  values: Record<string, unknown> | null;
  translation_status: "up_to_date" | "needs_update";
  source_hash: string | null;
}

/** One piece of shared content, as the plugin plans with it. */
export interface ChromeTarget {
  readonly key: string;
  readonly kind: "layout" | "instance";
  /** Operator-facing: what it is and where it shows. */
  readonly label: string;
  readonly fields: readonly ChromeField[];
  readonly values: Readonly<Record<string, unknown>>;
}

interface SharedContent {
  layoutPlacements: {
    layoutId: string;
    layoutSlug: string;
    blockName: string;
    index: number;
    moduleName: string;
    fields: ChromeField[];
    values: Record<string, unknown>;
  }[];
  sharedInstances: {
    contentInstanceId: string;
    slug: string | null;
    moduleName: string;
    fields: ChromeField[];
    values: Record<string, unknown>;
    pageIds: string[];
  }[];
}

/** Every chrome target of the live site. */
export async function loadChromeTargets(cms: ChromeCms): Promise<ChromeTarget[]> {
  const shared = await cms.call<SharedContent>("pages.list_shared_content", {});
  return [
    ...shared.layoutPlacements.map((p) => ({
      key: layoutTargetKey(p.layoutId, p.blockName, p.index),
      kind: "layout" as const,
      label: `${p.moduleName} — site layout "${p.layoutSlug}", ${p.blockName} area`,
      fields: p.fields,
      values: p.values,
    })),
    ...shared.sharedInstances.map((i) => ({
      key: instanceTargetKey(i.contentInstanceId),
      kind: "instance" as const,
      label: `${i.moduleName} — shared content${i.slug ? ` "${i.slug}"` : ""} on ${i.pageIds.length} page(s)`,
      fields: i.fields,
      values: i.values,
    })),
  ];
}

/** The plugin store caps a read at 1000 rows; past that this plugin
 *  would silently plan with half the data — refuse instead (CLAUDE.md §2). */
export async function listAll(q: PluginAdminQuery, table: string): Promise<unknown[]> {
  const rows = await q.list(table, { limit: 1000 });
  if (rows.length >= 1000) {
    throw new Error(
      `international-site: ${table} holds 1000+ rows, more than one read returns; paged reads are not implemented yet (file an issue)`,
    );
  }
  return rows;
}

/** Every stored chrome variant. */
export async function loadChromeVariants(q: PluginAdminQuery): Promise<ChromeVariantRow[]> {
  return (await listAll(q, "chrome_variants")) as unknown as ChromeVariantRow[];
}

function defaultLocaleOf(locales: ReadonlyMap<string, LocaleRow>): LocaleRow | null {
  for (const l of locales.values()) if (l.is_default) return l;
  return null;
}

function requireTargetLocale(deps: ChromeDeps, localeCode: string): LocaleRow {
  const locale = deps.locales.get(localeCode);
  if (!locale) {
    throw new Error(
      `locale "${localeCode}" is not registered — call intl_status for the registered locales`,
    );
  }
  if (locale.is_default) {
    throw new Error(
      `"${localeCode}" is the default language: its chrome IS the site's layout and shared content — edit those directly instead of adding a variant`,
    );
  }
  return locale;
}

/**
 * Mark translated variants whose source changed since they were derived.
 * Independent variants are never touched — that is what detaching means.
 *
 * @returns how many variants were newly marked `needs_update`.
 */
export async function refreshChromeStaleness(deps: ChromeDeps): Promise<number> {
  const variants = await loadChromeVariants(deps.q);
  if (variants.length === 0) return 0;
  const byKey = new Map((await loadChromeTargets(deps.cms)).map((t) => [t.key, t]));
  let marked = 0;
  for (const v of variants) {
    if (v.mode !== "translated" || v.translation_status === "needs_update") continue;
    const target = byKey.get(v.target_key);
    if (!target) continue; // the source was removed; the variant no longer renders
    const src = chromeSource(target);
    if (sourceFingerprint(src.fields, src.values) !== v.source_hash) {
      await deps.q.update("chrome_variants", v.id, { translation_status: "needs_update" });
      marked += 1;
    }
  }
  return marked;
}

/** Per target, per non-default locale: what the locale has. Feeds intl_status. */
export async function chromeStatus(deps: ChromeDeps): Promise<
  {
    targetKey: string;
    label: string;
    locales: Record<string, string>;
  }[]
> {
  await refreshChromeStaleness(deps);
  const targets = await loadChromeTargets(deps.cms);
  const variants = await loadChromeVariants(deps.q);
  const nonDefault = [...deps.locales.values()].filter((l) => !l.is_default);
  return targets.map((t) => {
    const translatable =
      translatableStrings(t.fields, t.values, chromeListContext(deps, t.kind)).length > 0;
    const locales: Record<string, string> = {};
    for (const l of nonDefault) {
      const v = variants.find((x) => x.target_key === t.key && x.locale_code === l.code);
      locales[l.code] = v
        ? `${v.mode}${v.mode === "translated" ? `/${v.translation_status}` : ""}${v.module_id ? " (own module)" : ""}`
        : translatable
          ? "missing"
          : "nothing to translate";
    }
    return { targetKey: t.key, label: t.label, locales };
  });
}

// ---------------------------------------------------------------------------
// The composition point.
// ---------------------------------------------------------------------------

const placementSchema = z
  .object({
    key: z.string(),
    scope: z.enum(["layout", "page"]),
    layoutId: z.string().nullable(),
    blockName: z.string(),
    position: z.number().int(),
    moduleId: z.string(),
    moduleName: z.string(),
    contentInstanceId: z.string().nullable(),
    shared: z.boolean(),
    fields: z.array(z.object({ name: z.string(), kind: z.string() }).passthrough()),
    values: z.record(z.string(), z.unknown()),
  })
  .strict();
const resolveArgs = z.object({
  pages: z.array(z.object({ pageId: z.string(), placements: z.array(placementSchema) }).strict()),
});

/**
 * Which chrome a page shows. Pages of the default language render the
 * site's own chrome untouched; a page in another language gets its
 * locale variant of every shared placement. A shared placement with text
 * but no variant comes back as a problem — never as the source language.
 * Internal links inside the values stay page references: core resolves
 * them per page to the same-language version (the `link_resolve` answer).
 *
 * @param localesByPage the plugin's page → locale resolution.
 */
export async function resolveChromeVariants(
  deps: ChromeDeps,
  rawArgs: unknown,
  localesByPage: (pageIds: string[]) => Promise<Map<string, LocaleRow>>,
): Promise<{ resolutions: Record<string, Record<string, unknown>> }> {
  const parsed = resolveArgs.parse(rawArgs);
  const pages = parsed.pages as ContentVariantPage[];
  const resolutions: Record<string, Record<string, unknown>> = {};
  if (deps.locales.size === 0 || pages.length === 0) return { resolutions };
  const pageLocale = await localesByPage(pages.map((p) => p.pageId));
  const localized = pages.filter((p) => pageLocale.get(p.pageId)?.is_default === false);
  if (localized.length === 0) return { resolutions };

  const variants = await loadChromeVariants(deps.q);
  const variantOf = (key: string, locale: string) =>
    variants.find((v) => v.target_key === key && v.locale_code === locale);
  // Layout placements carry their fields without list types; the chrome
  // targets (pages.list_shared_content) have them. Loaded only when a
  // layout placement has a list field.
  let targetsByKey: Map<string, ChromeTarget> | null = null;
  const fieldsOf = async (
    pl: (typeof pages)[number]["placements"][number],
    key: string,
  ): Promise<readonly ChromeField[]> => {
    if (pl.scope !== "layout" || !pl.fields.some((f) => f.kind === "list")) return pl.fields;
    targetsByKey ??= new Map((await loadChromeTargets(deps.cms)).map((t) => [t.key, t]));
    const target = targetsByKey.get(key);
    if (!target) {
      throw new Error(
        `international-site: layout placement ${key} is not among the site's shared content — the layout changed during this render; render again`,
      );
    }
    return target.fields;
  };

  for (const page of localized) {
    const locale = pageLocale.get(page.pageId) as LocaleRow;
    const perPage: Record<string, unknown> = {};
    for (const pl of page.placements) {
      if (!pl.shared) continue;
      const key =
        pl.scope === "layout"
          ? layoutTargetKey(pl.layoutId ?? "", pl.blockName, pl.position)
          : instanceTargetKey(pl.contentInstanceId ?? "");
      const v = variantOf(key, locale.code);
      if (v) {
        const moduleId = pl.scope === "layout" && v.module_id ? v.module_id : undefined;
        // A translated shared instance keeps rendering its CURRENT local
        // lists: their entries are translated by address (list-resolve),
        // so a source entry added since shows up there instead of the
        // copy frozen into the variant.
        const values =
          pl.scope === "page" && v.mode === "translated"
            ? {
                ...(v.values ?? {}),
                ...Object.fromEntries(
                  pl.fields
                    .filter((f) => f.kind === "list" && Object.hasOwn(pl.values, f.name))
                    .map((f) => [f.name, pl.values[f.name]]),
                ),
              }
            : (v.values ?? {});
        perPage[pl.key] = { ...(moduleId ? { moduleId } : {}), values };
      } else if (
        translatableStrings(
          await fieldsOf(pl, key),
          pl.values,
          chromeListContext(deps, pl.scope === "layout" ? "layout" : "instance"),
        ).length > 0
      ) {
        perPage[pl.key] = {
          problems: [
            `there is no ${locale.display_name} (${locale.code}) version of "${pl.moduleName}" (${pl.scope === "layout" ? `layout ${pl.blockName} area` : "shared content"}) yet. Next step: translate_chrome({localeCode: "${locale.code}"}) creates it; set_chrome_variants gives the language its own content.`,
          ],
        };
      }
    }
    if (Object.keys(perPage).length > 0) resolutions[page.pageId] = perPage;
  }
  return { resolutions };
}

// ---------------------------------------------------------------------------
// Writes: translate, detach (independent), re-attach.
// ---------------------------------------------------------------------------

async function upsertVariant(
  q: PluginAdminQuery,
  existing: ChromeVariantRow | undefined,
  row: Omit<ChromeVariantRow, "id">,
): Promise<void> {
  if (existing) {
    await q.update("chrome_variants", existing.id, { ...row });
  } else {
    await q.insert("chrome_variants", { ...row });
  }
}

/** Everything one locale's chrome translation is built from. */
export interface PreparedChromeTranslation {
  readonly locale: LocaleRow;
  readonly sourceLocale: LocaleRow;
  readonly upToDate: number;
  readonly skippedIndependent: number;
  readonly nothingToTranslate: number;
  /** The chrome targets the prompt asks for. */
  readonly offered: readonly (ChromeTranslationTarget & { target: ChromeTarget })[];
  /**
   * Epic #1107 — the list texts the prompt asks for, one target per list,
   * local list or page; each string's path is its value ADDRESS, and the
   * answer is stored by it (./list-translation-ops.ts).
   */
  readonly offeredLists: readonly (ChromeTranslationTarget & { units: readonly SourceUnit[] })[];
  /** The list state the list targets were picked from (null when none were asked for). */
  readonly listState: ListTranslationState | null;
  readonly variants: readonly ChromeVariantRow[];
  readonly glossary: readonly GlossaryEntry[];
  readonly styleGuide: string | null;
  /** Null when nothing is offered — there is no call to make. */
  readonly prompt: { readonly system: string; readonly user: string } | null;
}

/**
 * Pick the targets a locale's chrome translation covers — every target
 * that has text and whose variant is missing or translated-but-stale (or
 * the given targets, with `force`) — plus every list text of that locale
 * that is missing or stale, and build the ONE prompt for them: menus,
 * footer and header share vocabulary. Independent variants are skipped
 * unless forced (the re-attach path, after the Owner approved it; it
 * names its targets and offers no list texts). Writes nothing but
 * staleness markers.
 */
export async function prepareChromeTranslation(
  deps: ChromeDeps,
  args: { localeCode: string; targetKeys?: readonly string[]; force?: boolean },
): Promise<PreparedChromeTranslation> {
  const locale = requireTargetLocale(deps, args.localeCode);
  const source = defaultLocaleOf(deps.locales);
  if (!source) throw new Error("no default locale is registered — set_locales first");
  await refreshChromeStaleness(deps);
  const targets = await loadChromeTargets(deps.cms);
  const variants = await loadChromeVariants(deps.q);
  if (args.targetKeys) {
    const known = new Set(targets.map((t) => t.key));
    const unknown = args.targetKeys.filter((k) => !known.has(k));
    if (unknown.length > 0) {
      throw new Error(
        `unknown chrome target(s) ${unknown.join(", ")} — read intl_status for the current targetKeys`,
      );
    }
  }

  const counts = { upToDate: 0, skippedIndependent: 0, nothingToTranslate: 0 };
  const offered: (ChromeTranslationTarget & { target: ChromeTarget })[] = [];
  for (const t of targets) {
    if (args.targetKeys && !args.targetKeys.includes(t.key)) continue;
    const strings = translatableStrings(t.fields, t.values, chromeListContext(deps, t.kind));
    if (strings.length === 0) {
      counts.nothingToTranslate += 1;
      continue;
    }
    const v = variants.find((x) => x.target_key === t.key && x.locale_code === locale.code);
    if (!args.force && v?.mode === "independent") {
      counts.skippedIndependent += 1;
      continue;
    }
    if (!args.force && v?.mode === "translated" && v.translation_status === "up_to_date") {
      counts.upToDate += 1;
      continue;
    }
    offered.push({ id: `c${offered.length}`, label: t.label, strings, target: t });
  }
  const listState = args.targetKeys ? null : await loadListTranslationState(deps);
  const offeredLists = (listState ? listWorkTargets(listState, locale.code) : []).map((t, i) => ({
    id: `c${offered.length + i}`,
    label: t.label,
    strings: t.units.map((u) => ({ path: u.address, text: u.text })),
    units: t.units,
  }));
  const base = {
    locale,
    sourceLocale: source,
    ...counts,
    offered,
    offeredLists,
    listState,
    variants,
  };
  if (offered.length === 0 && offeredLists.length === 0) {
    return { ...base, glossary: [], styleGuide: null, prompt: null };
  }

  const glossary = (
    (await deps.q.list("glossary", { locale_code: locale.code, limit: 500 })) as unknown as {
      term: string;
      translation: string;
      context: string | null;
    }[]
  ).map((g): GlossaryEntry => ({ term: g.term, translation: g.translation, context: g.context }));
  const style = (
    (await deps.q.list("style_guides", { locale_code: locale.code, limit: 1 })) as unknown as {
      body: string;
    }[]
  )[0];
  const styleGuide = style?.body ?? null;
  const prompt = buildChromeTranslationPrompt({
    sourceLocale: source.code,
    targetLocale: locale.code,
    targetLocaleDisplayName: locale.display_name,
    targets: [...offered, ...offeredLists],
    glossaryBlock: renderGlossaryBlock(glossary),
    styleGuideBlock: renderStyleGuideBlock(styleGuide),
  });
  return { ...base, glossary, styleGuide, prompt };
}

/**
 * #741 — fingerprint of what a prepared chrome translation asks for: the
 * offered targets' strings (the answer is keyed by their ids and paths),
 * glossary and style guide. Labels stay out — they count pages, which a
 * page translation's fork can change without touching a single string.
 */
export function chromeTranslationBasis(p: PreparedChromeTranslation): Promise<string> {
  return basisOf({
    kind: "chrome",
    sourceLocale: p.sourceLocale.code,
    locale: p.locale.code,
    offered: p.offered.map((o) => ({ id: o.id, key: o.target.key, strings: o.strings })),
    offeredLists: p.offeredLists.map((o) => ({
      id: o.id,
      strings: o.strings,
      hashes: o.units.map((u) => u.hash),
    })),
    glossary: p.glossary,
    styleGuide: p.styleGuide,
  });
}

/** The answered list texts of a chrome answer, by address (epic #1107). */
export function chromeListAnswers(
  p: PreparedChromeTranslation,
  payload: ChromeTranslationPayload,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const answer of payload.targets) {
    if (!p.offeredLists.some((x) => x.id === answer.target)) continue;
    for (const [address, text] of Object.entries(answer.strings)) out.set(address, text);
  }
  return out;
}

/**
 * Parse a model's answer and hold it to the chrome contract: exactly the
 * offered targets and paths — and every answered list text valid for its
 * field. Throws on anything that may not be written.
 *
 * @param answer raw answer text (a ```json fence is tolerated), or the
 *   JSON value an agent already parsed.
 * @param retryHint the next step named when the answer is not the JSON
 *   the prompt asked for.
 */
export function parseChromeTranslationAnswer(
  answer: string | Readonly<Record<string, unknown>>,
  p: PreparedChromeTranslation,
  retryHint: string,
): ChromeTranslationPayload {
  let payload: ChromeTranslationPayload;
  try {
    payload = chromeTranslationPayload.parse(
      typeof answer === "string" ? JSON.parse(stripJsonFence(answer)) : answer,
    );
  } catch (e) {
    throw new Error(
      `chrome translation response did not match the contract: ${(e as Error).message}. ${retryHint}`,
    );
  }
  validateChromeTranslation(payload, [...p.offered, ...p.offeredLists]);
  const listAnswers = chromeListAnswers(p, payload);
  if (listAnswers.size > 0 && p.listState) {
    checkListTranslations(p.listState, p.locale, listAnswers);
  }
  return payload;
}

/**
 * Upsert every answered target as a `translated`, up-to-date variant
 * (dropping an own module — re-attach lands here).
 *
 * @returns how many variants were written.
 */
export async function writeChromeTranslation(
  deps: ChromeDeps,
  p: PreparedChromeTranslation,
  payload: ChromeTranslationPayload,
): Promise<number> {
  // Two passes, like set_chrome_variants: every answer's links are
  // checked before the first row is written. Rich text carries the
  // source's stored links (`caelo:page/<id>` references) into the
  // translation and back; a translator that rewrote one into a path, or
  // broke it, goes through core's write-time canonicalisation like any
  // other write (#724) — the path becomes a reference, a broken
  // reference refuses the batch instead of shipping a dead link. Links
  // the source already holds are grandfathered (its own literals are
  // E's and F's to report).
  const rows: { existing: ChromeVariantRow | undefined; row: Omit<ChromeVariantRow, "id"> }[] = [];
  for (const answer of payload.targets) {
    const o = p.offered.find((x) => x.id === answer.target);
    if (!o) continue; // validateChromeTranslation refused these
    const existing = p.variants.find(
      (x) => x.target_key === o.target.key && x.locale_code === p.locale.code,
    );
    const values = await canonicaliseChromeLinks(
      deps.cms,
      o.target.fields,
      applyStrings(o.target.values, answer.strings),
      o.target.values,
    );
    rows.push({
      existing,
      row: {
        target_key: o.target.key,
        locale_code: p.locale.code,
        mode: "translated",
        module_id: null,
        values,
        translation_status: "up_to_date",
        source_hash: (() => {
          const src = chromeSource(o.target);
          return sourceFingerprint(src.fields, src.values);
        })(),
      },
    });
  }
  // Epic #1107 — list texts by address, validated as one batch before
  // the chrome rows are written, so a refused value writes neither.
  const listAnswers = chromeListAnswers(p, payload);
  let listWritten = 0;
  if (listAnswers.size > 0) {
    if (!p.listState) throw new Error("chrome translation: list answers without a list state");
    listWritten = await writeListTranslations(deps, p.listState, p.locale, listAnswers);
  }
  for (const { existing, row } of rows) await upsertVariant(deps.q, existing, row);
  return rows.length + listWritten;
}

/** The install-side pass: prepare → the install's AI → write, in ONE call. */
export async function translateChrome(
  deps: ChromeDeps,
  ai: PluginAi,
  args: { localeCode: string; targetKeys?: readonly string[]; force?: boolean },
): Promise<{
  translated: number;
  upToDate: number;
  skippedIndependent: number;
  nothingToTranslate: number;
}> {
  const p = await prepareChromeTranslation(deps, args);
  const counts = (translated: number) => ({
    translated,
    upToDate: p.upToDate,
    skippedIndependent: p.skippedIndependent,
    nothingToTranslate: p.nothingToTranslate,
  });
  if (p.prompt === null) return counts(0);
  // #992 — SDK structured output constrained to this call's targets and
  // paths (CLAUDE.md §12), not JSON parsed out of free text.
  const retryHint = "Re-run translate_chrome.";
  const result = await ai.generateObject({
    system: p.prompt.system,
    messages: [{ role: "user", content: p.prompt.user }],
    jsonSchema: chromeTranslationJsonSchema([...p.offered, ...p.offeredLists]),
    maxTokens: 16_000,
    purpose: "translation",
  });
  if (result.object === undefined || result.object === null || typeof result.object !== "object") {
    throw new Error(
      `chrome translation response did not match the contract: the model returned no object that fits the schema. ${retryHint}`,
    );
  }
  const payload = parseChromeTranslationAnswer(
    result.object as Readonly<Record<string, unknown>>,
    p,
    retryHint,
  );
  return counts(await writeChromeTranslation(deps, p, payload));
}

const setVariantsArgs = z
  .object({
    variants: z
      .array(
        z
          .object({
            targetKey: z.string().min(1),
            localeCode: z.string().min(2).max(35),
            values: z.record(z.string(), z.unknown()).optional(),
            moduleId: z.string().uuid().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();

/**
 * Give locales their own chrome content (detach → `independent`): own
 * values, own items and links, or — in a layout slot — another module.
 * Omitted `values` keep what the language shows now, so detaching alone
 * freezes the current translation against future source edits.
 *
 * Given values go through core's link canonicalisation first (#724):
 * `/pricing` is stored as a reference to that page — rendered on a
 * German page as the German version, flagged when there is none — and a
 * path that names no page is refused with core's next step.
 */
export async function setChromeVariants(
  deps: ChromeDeps,
  rawArgs: unknown,
): Promise<{ updated: { targetKey: string; localeCode: string }[] }> {
  const args = setVariantsArgs.parse(rawArgs);
  const targets = new Map((await loadChromeTargets(deps.cms)).map((t) => [t.key, t]));
  const variants = await loadChromeVariants(deps.q);
  // Two passes so the batch is all-or-nothing (CLAUDE.md §11): every
  // variant is checked and its links canonicalised BEFORE the first row
  // is written — a refused variant N must not leave 0..N-1 stored.
  const rows: { existing: ChromeVariantRow | undefined; row: Omit<ChromeVariantRow, "id"> }[] = [];
  for (const v of args.variants) {
    requireTargetLocale(deps, v.localeCode);
    const target = targets.get(v.targetKey);
    if (!target) {
      throw new Error(
        `unknown chrome target "${v.targetKey}" — read intl_status for the current targetKeys`,
      );
    }
    if (v.moduleId && target.kind !== "layout") {
      throw new Error(
        `"${v.targetKey}" is shared page content; only a layout slot (header, footer, menu area) can show a different module per language — change its values instead`,
      );
    }
    const existing = variants.find(
      (x) => x.target_key === v.targetKey && x.locale_code === v.localeCode,
    );
    const values =
      v.values !== undefined
        ? await canonicaliseChromeLinks(
            deps.cms,
            v.moduleId ? [] : target.fields,
            v.values,
            existing?.values ?? undefined,
          )
        : v.moduleId
          ? {}
          : (existing?.values ?? { ...target.values });
    rows.push({
      existing,
      row: {
        target_key: v.targetKey,
        locale_code: v.localeCode,
        mode: "independent",
        module_id: v.moduleId ?? (v.values === undefined ? (existing?.module_id ?? null) : null),
        values,
        translation_status: "up_to_date",
        source_hash: null,
      },
    });
  }
  for (const { existing, row } of rows) await upsertVariant(deps.q, existing, row);
  return {
    updated: rows.map(({ row }) => ({ targetKey: row.target_key, localeCode: row.locale_code })),
  };
}

/**
 * Core's write-time link canonicalisation for a variant's values.
 * A swapped-in module's field kinds are not known here; core still
 * recognises link keys (`href`, `*_url`, …) and HTML attributes.
 *
 * @param previous the values this write replaces or derives from; their
 *   link literals are grandfathered, as for a core update.
 */
async function canonicaliseChromeLinks(
  cms: ChromeCms,
  fields: readonly ChromeField[],
  values: Record<string, unknown>,
  previous: Readonly<Record<string, unknown>> | undefined,
): Promise<Record<string, unknown>> {
  const r = await cms.call<{ values: Record<string, unknown> }>("links.canonicalise_values", {
    fields: fields.map((f) => ({ name: f.name, kind: f.kind })),
    values,
    ...(previous ? { previous } : {}),
  });
  return r.values;
}

const reattachArgs = z
  .object({ targetKey: z.string().min(1), localeCode: z.string().min(2).max(35) })
  .strict();

/**
 * Re-attach a detached variant: back to `translated`, own module
 * dropped, content re-derived from the source NOW (overwriting the
 * language's own content — which is why its tool is approval-gated).
 */
export async function reattachChromeVariant(
  deps: ChromeDeps,
  ai: PluginAi,
  rawArgs: unknown,
): Promise<{ translated: number }> {
  const args = reattachArgs.parse(rawArgs);
  requireTargetLocale(deps, args.localeCode);
  const r = await translateChrome(deps, ai, {
    localeCode: args.localeCode,
    targetKeys: [args.targetKey],
    force: true,
  });
  return { translated: r.translated };
}

/**
 * #741 — re-attach when the AI work belongs to the calling agent: the
 * approved half without the translation. The entry flips to
 * `translated` + `needs_update`, which is exactly what translate_chrome
 * offers, so the agent's next translate_chrome work item covers it.
 *
 * The own module and own values stay until that answer is applied —
 * writeChromeTranslation drops the module and replaces the values in one
 * upsert. Dropping them here would leave the language rendering the
 * source module with the detached values (or none) in between; keeping
 * them, the language shows its own, still correct-language chrome until
 * the translation lands. The Owner's approval covered "this entry
 * follows the source again"; the overwrite itself is then an ordinary
 * translated-chrome write.
 */
export async function reattachChromeVariantDelegated(
  deps: ChromeDeps,
  rawArgs: unknown,
): Promise<{ reattached: boolean; translated: 0; nextStep: string }> {
  const args = reattachArgs.parse(rawArgs);
  const locale = requireTargetLocale(deps, args.localeCode);
  const target = (await loadChromeTargets(deps.cms)).find((t) => t.key === args.targetKey);
  if (!target) {
    throw new Error(
      `unknown chrome target(s) ${args.targetKey} — read intl_status for the current targetKeys`,
    );
  }
  // Mirrors the install path: a target without text is never offered,
  // so a forced translation of it changes nothing.
  if (
    translatableStrings(target.fields, target.values, chromeListContext(deps, target.kind))
      .length === 0
  ) {
    return {
      reattached: false,
      translated: 0,
      nextStep: `"${target.label}" has no text to translate, so there is nothing to re-attach; the ${locale.display_name} entry is unchanged.`,
    };
  }
  const existing = (await loadChromeVariants(deps.q)).find(
    (v) => v.target_key === args.targetKey && v.locale_code === locale.code,
  );
  if (existing) {
    await deps.q.update("chrome_variants", existing.id, {
      mode: "translated",
      translation_status: "needs_update",
      source_hash: null,
    });
  }
  return {
    reattached: true,
    translated: 0,
    nextStep: `The ${locale.display_name} entry follows the default language again but is not translated yet (it keeps showing its current content until then). Call translate_chrome({ localeCode: "${locale.code}" }) for the work item, translate it yourself, and send the answer back with apply_translations.`,
  };
}
