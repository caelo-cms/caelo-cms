// SPDX-License-Identifier: MPL-2.0

/**
 * The site search's page-output observer (issue #1651): every Stage, the
 * pages whose output changed come in batches; the plugin turns each into
 * its page document and its anchor documents, by the counting rules, and
 * at the end sets the search profile and writes the index report.
 */

import type {
  ConfigEntityKind,
  PageOutputFacts,
  PageOutputObserverArgs,
  PluginCollections,
  PluginContext,
  PluginContextTier1,
} from "@caelo-cms/plugin-sdk";
import { anchorDocuments, pageDocument } from "./documents.js";
import { buildProfile, type ListEntry, profileConfigOf } from "./profile.js";
import {
  type CountingSettings,
  type ModuleSettings,
  type ModuleVerdict,
  moduleWeighting,
  pageExclusion,
  type SearchMode,
} from "./rules.js";

type Ctx = PluginContext & Partial<Pick<PluginContextTier1, "adminQuery" | "cms">>;

/** The languages a list entry without a language applies to: every one the engine stems. */
export const ALL_LANGUAGES = [
  "ar", "da", "de", "en", "es", "fi", "fr", "hu", "it", "nl", "no", "pt", "ro", "ru", "sv", "tr",
] as const;

function collectionsOf(ctx: Ctx): PluginCollections & {
  pages: NonNullable<PluginCollections["pages"]>;
  anchors: NonNullable<PluginCollections["anchors"]>;
} {
  const c = ctx.collections;
  if (!c?.pages || !c.anchors)
    throw new Error("site-search: the collections grant is missing (Settings → Plugins approves it)");
  return c as never;
}

function countingOf(values: Readonly<Record<string, unknown>>): CountingSettings {
  const c = (values.counting ?? {}) as Record<string, unknown>;
  return {
    fullMax: Number(c.full_max),
    reducedMax: Number(c.reduced_max),
    chromeLinks: c.chrome_links === true,
  };
}

async function entities(
  ctx: Ctx,
  kind: ConfigEntityKind,
  ids: readonly string[],
): Promise<ReadonlyMap<string, Readonly<Record<string, unknown>>>> {
  if (ids.length === 0 || !ctx.config) return new Map();
  const out = new Map<string, Readonly<Record<string, unknown>>>();
  for (let i = 0; i < ids.length; i += 1000) {
    for (const [id, v] of await ctx.config.entities(kind, ids.slice(i, i + 1000))) out.set(id, v);
  }
  return out;
}

/** One module's counting as the index report shows it. */
export interface ModuleReportRow {
  readonly moduleId: string;
  readonly name: string;
  readonly zone: string;
  readonly placement: number;
  readonly weighting: string;
  readonly reason: string;
}

/** What one observer call did, for the tests and the report. */
export interface ObserveResult {
  readonly indexed: number;
  readonly excluded: number;
  readonly anchors: number;
  readonly modules: readonly ModuleReportRow[];
  readonly notes: readonly string[];
}

/** Turns one page's facts into its verdicts per module. */
export function verdictsOf(
  facts: PageOutputFacts,
  publishedPages: number,
  counting: CountingSettings,
  moduleSettings: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
  instanceSettings: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
): Map<string, ModuleVerdict> {
  const out = new Map<string, ModuleVerdict>();
  for (const m of facts.modules) {
    const ms = moduleSettings.get(m.moduleId);
    const settings: ModuleSettings | undefined = ms
      ? { mode: (ms.mode as SearchMode) ?? "auto", homePage: (ms.home_page as string | null) ?? null }
      : undefined;
    const instanceMode = m.contentInstanceId
      ? (instanceSettings.get(m.contentInstanceId)?.mode as SearchMode | undefined)
      : undefined;
    out.set(
      m.moduleId,
      moduleWeighting(m, facts.pageId, publishedPages, counting, settings, instanceMode),
    );
  }
  return out;
}

async function listEntries(ctx: Ctx, listId: unknown): Promise<ListEntry[]> {
  if (typeof listId !== "string" || !ctx.cms) return [];
  const r = await ctx.cms.call<{ list: { items: ListEntry[] } }>("lists.get", { id: listId });
  const flat: ListEntry[] = [];
  const walk = (items: readonly (ListEntry & { children?: ListEntry[] })[]) => {
    for (const it of items) {
      flat.push({ node: it.node, values: it.values });
      if (it.children) walk(it.children);
    }
  };
  walk(r.list.items as never);
  return flat;
}

/** The observer operation. */
export async function observe(ctx: Ctx, args: PageOutputObserverArgs): Promise<ObserveResult> {
  if (!ctx.config) throw new Error("site-search: its configuration is not readable");
  const { pages, anchors } = collectionsOf(ctx);
  const values = await ctx.config.get();
  const counting = countingOf(values);
  const resultsPage = (values.results_page as string | null) ?? null;
  const moduleIds = [...new Set(args.pages.flatMap((p) => p.modules.map((m) => m.moduleId)))];
  const instanceIds = [
    ...new Set(
      args.pages.flatMap((p) =>
        p.modules.map((m) => m.contentInstanceId).filter((x): x is string => x !== null),
      ),
    ),
  ];
  const moduleSettings = await entities(ctx, "module", moduleIds);
  const instanceSettings = await entities(ctx, "contentInstance", instanceIds);
  const pageSettings = await entities(
    ctx,
    "page",
    args.pages.map((p) => p.pageId),
  );
  const placement = new Map<string, number>();
  for (const p of args.pages) for (const m of p.modules) placement.set(m.moduleId, m.placementCount);

  const upserts = [];
  const excluded: string[] = [];
  const anchorDocs = new Map<string, ReturnType<typeof anchorDocuments>[number]>();
  const anchorSources = new Set<string>();
  const report = new Map<string, ModuleReportRow>();
  for (const facts of args.pages) {
    anchorSources.add(`p:${facts.pageId}`);
    for (const m of facts.modules) if (m.zone === "layout") anchorSources.add(`m:${m.moduleId}`);
    for (const d of anchorDocuments(facts, {
      chromeLinks: counting.chromeLinks,
      placementOf: (id) => placement.get(id) ?? 1,
    }))
      anchorDocs.set(d.id, d);
    const exclusion = pageExclusion(facts, {
      resultsPage,
      excluded: pageSettings.get(facts.pageId)?.excluded === true,
    });
    if (exclusion) {
      excluded.push(facts.pageId);
      continue;
    }
    const verdicts = verdictsOf(
      facts,
      args.publishedPageCount,
      counting,
      moduleSettings,
      instanceSettings,
    );
    for (const m of facts.modules) {
      const v = verdicts.get(m.moduleId) as ModuleVerdict;
      // A module's verdict differs only between its home page and the
      // rest; the report shows how it counts on the other pages.
      if (v.reason === "home-page" && report.has(m.moduleId)) continue;
      report.set(m.moduleId, {
        moduleId: m.moduleId,
        name: m.name,
        zone: m.zone,
        placement: m.placementCount,
        weighting: v.weighting,
        reason: v.reason,
      });
    }
    upserts.push(pageDocument(facts, verdicts));
  }
  // The links of these pages and chrome modules replace what they said
  // before, as one change (the index removes, then adds).
  if (anchorSources.size > 0)
    await anchors.replace("source", [...anchorSources], [...anchorDocs.values()]);
  if (excluded.length > 0) await pages.delete(excluded);
  if (upserts.length > 0) await pages.upsert(upserts);

  const notes: string[] = [];
  if (args.final) {
    if (args.removed.length > 0) {
      await pages.delete(args.removed);
      await anchors.replace("source", args.removed.map((id) => `p:${id}`), []);
      await anchors.replace("target", args.removed, []);
    }
    const goneModules = args.placementChanges.filter((c) => c.after === 0);
    if (goneModules.length > 0)
      await anchors.replace("source", goneModules.map((c) => `m:${c.moduleId}`), []);
    const lists = (values.lists ?? {}) as Record<string, unknown>;
    const built = buildProfile(
      profileConfigOf(values),
      {
        synonyms: await listEntries(ctx, lists.synonyms),
        bestBets: await listEntries(ctx, lists.best_bets),
        suggestions: await listEntries(ctx, lists.suggestions),
        protectedTerms: await listEntries(ctx, lists.protected_terms),
      },
      ALL_LANGUAGES,
      { has: () => true },
    );
    notes.push(...built.notes);
    await pages.setProfile(built.profile);
    const anchorWeight = profileConfigOf(values).anchorWeight;
    await anchors.setProfile({
      ...built.profile,
      weights: { text: anchorWeight },
      boosts: [],
      bestBets: {},
      suggestions: {},
    });
  }
  return {
    indexed: upserts.length,
    excluded: excluded.length,
    anchors: anchorDocs.size,
    modules: [...report.values()],
    notes,
  };
}
