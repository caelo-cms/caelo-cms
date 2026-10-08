// SPDX-License-Identifier: MPL-2.0

/**
 * #592 — per-locale site chrome, the I/O half: the content-variants
 * resolver core calls while rendering, the translation flow, the
 * detach/re-attach writes and the staleness refresh. Pure helpers live
 * in ./chrome.ts; see its header for the model.
 */

import type {
  ContentVariantPage,
  PageUrlStyle,
  PluginAdminQuery,
  PluginAi,
} from "@caelo-cms/plugin-sdk";
import { z } from "@caelo-cms/plugin-sdk";
import {
  applyStrings,
  buildChromeTranslationPrompt,
  type ChromeField,
  type ChromeTranslationTarget,
  chromeTranslationPayload,
  instanceTargetKey,
  type LinkMapping,
  layoutTargetKey,
  mapLinks,
  normalizePath,
  sourceFingerprint,
  splitHref,
  translatableStrings,
  validateChromeTranslation,
} from "./chrome.js";
import type { LocaleRow, PageVariantRow } from "./index.js";
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
async function listAll(q: PluginAdminQuery, table: string): Promise<unknown[]> {
  const rows = await q.list(table, { limit: 1000 });
  if (rows.length >= 1000) {
    throw new Error(
      `international-site:  holds 1000+ rows, more than one read returns; paged reads are not implemented yet (file an issue)`,
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
    if (sourceFingerprint(target.fields, target.values) !== v.source_hash) {
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
    const translatable = translatableStrings(t.fields, t.values).length > 0;
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
    fields: z.array(z.object({ name: z.string(), kind: z.string() })),
    values: z.record(z.string(), z.unknown()),
  })
  .strict();
const resolveArgs = z.object({
  pageUrlStyle: z.enum(["directory", "no-extension"]),
  pages: z.array(z.object({ pageId: z.string(), placements: z.array(placementSchema) }).strict()),
});

/**
 * Which chrome a page shows. Pages of the default language render the
 * site's own chrome untouched; a page in another language gets its
 * locale variant of every shared placement, with internal links mapped
 * to the same-language pages. A shared placement with text but no
 * variant, and a link whose target has no published page in the
 * language, come back as problems — never as the source language.
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
  const pageUrlStyle: PageUrlStyle = parsed.pageUrlStyle;
  const resolutions: Record<string, Record<string, unknown>> = {};
  if (deps.locales.size === 0 || pages.length === 0) return { resolutions };
  const pageLocale = await localesByPage(pages.map((p) => p.pageId));
  const localized = pages.filter((p) => pageLocale.get(p.pageId)?.is_default === false);
  if (localized.length === 0) return { resolutions };

  const variants = await loadChromeVariants(deps.q);
  const variantOf = (key: string, locale: string) =>
    variants.find((v) => v.target_key === key && v.locale_code === locale);
  const links = await linkIndex(deps, pageUrlStyle);

  for (const page of localized) {
    const locale = pageLocale.get(page.pageId) as LocaleRow;
    const perPage: Record<string, unknown> = {};
    for (const pl of page.placements) {
      let values: Readonly<Record<string, unknown>> = pl.values;
      let moduleId: string | undefined;
      let overridden = false;
      const problems: string[] = [];
      if (pl.shared) {
        const key =
          pl.scope === "layout"
            ? layoutTargetKey(pl.layoutId ?? "", pl.blockName, pl.position)
            : instanceTargetKey(pl.contentInstanceId ?? "");
        const v = variantOf(key, locale.code);
        if (v) {
          values = v.values ?? {};
          moduleId = pl.scope === "layout" && v.module_id ? v.module_id : undefined;
          overridden = true;
        } else if (translatableStrings(pl.fields, pl.values).length > 0) {
          problems.push(
            `there is no ${locale.display_name} (${locale.code}) version of "${pl.moduleName}" (${pl.scope === "layout" ? `layout ${pl.blockName} area` : "shared content"}) yet. Next step: translate_chrome({localeCode: "${locale.code}"}) creates it; set_chrome_variants gives the language its own content.`,
          );
        }
      }
      // A swapped-in module's field kinds are unknown here; its link
      // lists are still recognised by shape.
      const mapped = mapLinks(moduleId ? [] : pl.fields, values, (href) => links.map(href, locale));
      for (const p of mapped.problems) problems.push(`"${pl.moduleName}": ${p}`);
      if (mapped.changed) {
        values = mapped.values;
        overridden = true;
      }
      if (!overridden && problems.length === 0) continue;
      perPage[pl.key] = {
        ...(moduleId ? { moduleId } : {}),
        ...(overridden ? { values } : {}),
        ...(problems.length > 0 ? { problems } : {}),
      };
    }
    if (Object.keys(perPage).length > 0) resolutions[page.pageId] = perPage;
  }
  return { resolutions };
}

/** Internal path → page, and page → its language versions. */
async function linkIndex(
  deps: ChromeDeps,
  pageUrlStyle: PageUrlStyle,
): Promise<{
  map: (href: string, locale: LocaleRow) => LinkMapping;
}> {
  const pages = (
    await deps.cms.call<{ pages: { id: string; status: string; currentPath: string }[] }>(
      "pages.list",
      {},
    )
  ).pages;
  const byPath = new Map(pages.map((p) => [normalizePath(p.currentPath), p]));
  const byId = new Map(pages.map((p) => [p.id, p]));
  const variantRows = (await listAll(deps.q, "page_variants")) as unknown as PageVariantRow[];
  const rowByPage = new Map(variantRows.map((r) => [r.page_id, r]));
  const def = defaultLocaleOf(deps.locales);
  const localeOf = (pageId: string) => rowByPage.get(pageId)?.locale_code ?? def?.code;
  // #590 — a rewritten link carries the target's canonical path from core's
  // URL builder (trailing slash per the serving target), never one
  // composed here. Same-language targets share the host, so the path is
  // enough.
  const linkable = variantRows
    .map((r) => r.page_id)
    .filter((id) => byId.get(id)?.status === "published");
  const canonicalPath = new Map<string, string>();
  for (let i = 0; i < linkable.length; i += 1000) {
    const { urls } = await deps.cms.call<{ urls: Record<string, string> }>(
      "pages.resolve_public_urls",
      { pageIds: linkable.slice(i, i + 1000), pageUrlStyle },
    );
    for (const [id, url] of Object.entries(urls)) canonicalPath.set(id, new URL(url).pathname);
  }

  return {
    map: (href, locale) => {
      const parts = splitHref(href);
      if (!parts) return null; // external, mailto:, anchors — not a page link
      const target = byPath.get(normalizePath(parts.path));
      if (!target) return null; // an asset or a path no page owns
      if (localeOf(target.id) === locale.code) return null;
      const row = rowByPage.get(target.id);
      const sibling = row
        ? variantRows.find((r) => r.group_id === row.group_id && r.locale_code === locale.code)
        : undefined;
      const siblingPage = sibling ? byId.get(sibling.page_id) : undefined;
      if (!siblingPage) {
        return {
          problem: `the link "${href}" goes to a page that has no ${locale.display_name} version. Next step: create_variant + translate_variant for that page, or change the link with set_chrome_variants.`,
        };
      }
      if (siblingPage.status !== "published") {
        return {
          problem: `the link "${href}" goes to a page whose ${locale.display_name} version (${siblingPage.currentPath}) is not published yet. Next step: publish it, or change the link.`,
        };
      }
      const path = canonicalPath.get(siblingPage.id);
      if (path === undefined) {
        throw new Error(`international-site: core resolved no URL for page ${siblingPage.id}`);
      }
      return { href: `${path}${parts.suffix}` };
    },
  };
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

/**
 * Translate a locale's chrome in ONE AI call: every target that has
 * text and whose variant is missing or translated-but-stale (or the
 * given targets, with `force`). Independent variants are skipped unless
 * forced (the re-attach path, after the Owner approved it).
 */
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

  const counts = { translated: 0, upToDate: 0, skippedIndependent: 0, nothingToTranslate: 0 };
  const offered: (ChromeTranslationTarget & { target: ChromeTarget })[] = [];
  for (const t of targets) {
    if (args.targetKeys && !args.targetKeys.includes(t.key)) continue;
    const strings = translatableStrings(t.fields, t.values);
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
  if (offered.length === 0) return counts;

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
  const prompt = buildChromeTranslationPrompt({
    sourceLocale: source.code,
    targetLocale: locale.code,
    targetLocaleDisplayName: locale.display_name,
    targets: offered,
    glossaryBlock: renderGlossaryBlock(glossary),
    styleGuideBlock: renderStyleGuideBlock(style?.body ?? null),
  });
  const result = await ai.complete({
    system: prompt.system,
    messages: [{ role: "user", content: prompt.user }],
    maxTokens: 16_000,
    purpose: "translation",
  });
  let payload: z.infer<typeof chromeTranslationPayload>;
  try {
    payload = chromeTranslationPayload.parse(JSON.parse(stripJsonFence(result.text)));
  } catch (e) {
    throw new Error(
      `chrome translation response did not match the contract: ${(e as Error).message}. Re-run translate_chrome.`,
    );
  }
  validateChromeTranslation(payload, offered);

  for (const answer of payload.targets) {
    const o = offered.find((x) => x.id === answer.target);
    if (!o) continue; // validateChromeTranslation refused these
    const existing = variants.find(
      (x) => x.target_key === o.target.key && x.locale_code === locale.code,
    );
    await upsertVariant(deps.q, existing, {
      target_key: o.target.key,
      locale_code: locale.code,
      mode: "translated",
      module_id: null,
      values: applyStrings(o.target.values, answer.strings),
      translation_status: "up_to_date",
      source_hash: sourceFingerprint(o.target.fields, o.target.values),
    });
    counts.translated += 1;
  }
  return counts;
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
 */
export async function setChromeVariants(
  deps: ChromeDeps,
  rawArgs: unknown,
): Promise<{ updated: { targetKey: string; localeCode: string }[] }> {
  const args = setVariantsArgs.parse(rawArgs);
  const targets = new Map((await loadChromeTargets(deps.cms)).map((t) => [t.key, t]));
  const variants = await loadChromeVariants(deps.q);
  const updated: { targetKey: string; localeCode: string }[] = [];
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
    const values = v.values ?? (v.moduleId ? {} : (existing?.values ?? { ...target.values }));
    await upsertVariant(deps.q, existing, {
      target_key: v.targetKey,
      locale_code: v.localeCode,
      mode: "independent",
      module_id: v.moduleId ?? (v.values === undefined ? (existing?.module_id ?? null) : null),
      values,
      translation_status: "up_to_date",
      source_hash: null,
    });
    updated.push({ targetKey: v.targetKey, localeCode: v.localeCode });
  }
  return { updated };
}

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
  const args = z
    .object({ targetKey: z.string().min(1), localeCode: z.string().min(2).max(35) })
    .strict()
    .parse(rawArgs);
  requireTargetLocale(deps, args.localeCode);
  const r = await translateChrome(deps, ai, {
    localeCode: args.localeCode,
    targetKeys: [args.targetKey],
    force: true,
  });
  return { translated: r.translated };
}
