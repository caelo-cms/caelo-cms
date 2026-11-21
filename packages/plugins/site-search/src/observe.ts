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
import { type AnchorDoc, anchorDocuments, pageDocument } from "./documents.js";
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
  "ar",
  "da",
  "de",
  "en",
  "es",
  "fi",
  "fr",
  "hu",
  "it",
  "nl",
  "no",
  "pt",
  "ro",
  "ru",
  "sv",
  "tr",
] as const;

function collectionsOf(ctx: Ctx): PluginCollections & {
  pages: NonNullable<PluginCollections["pages"]>;
  anchors: NonNullable<PluginCollections["anchors"]>;
} {
  const c = ctx.collections;
  if (!c?.pages || !c.anchors)
    throw new Error(
      "site-search: the collections grant is missing (Settings → Plugins approves it)",
    );
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
  /** A navigation block's anchor texts, digested: unchanged links are not rewritten. */
  readonly anchorsDigest?: string;
}

/** A 64-bit FNV-1a digest of a JSON value (change detection, not security). */
export function digestOf(value: unknown): string {
  let h = 0xcbf29ce484222325n;
  for (const ch of JSON.stringify(value)) {
    h ^= BigInt(ch.codePointAt(0) ?? 0);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

/** The stored anchor digests of navigation blocks (module_counting.anchors_digest). */
async function chromeDigests(ctx: Ctx, moduleIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ctx.adminQuery || moduleIds.length === 0) return out;
  for (let i = 0; i < moduleIds.length; i += 1000) {
    for (const r of await ctx.adminQuery.list<
      "module_counting",
      { module_id: string; anchors_digest: string }
    >("module_counting", { anyOf: { module_id: moduleIds.slice(i, i + 1000) }, limit: 1000 }))
      if (r.anchors_digest) out.set(r.module_id, r.anchors_digest);
  }
  return out;
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
      ? {
          mode: (ms.mode as SearchMode) ?? "auto",
          homePage: (ms.home_page as string | null) ?? null,
        }
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
  if (typeof listId !== "string") return [];
  if (!ctx.cms)
    throw new Error(
      "site-search: reading its lists needs the cms_admin grant (Settings → Plugins approves it)",
    );
  const r = await ctx.cms.call<{ id: string }, { list: { items: ListEntry[] } }>("lists.get", {
    id: listId,
  });
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
  for (const p of args.pages)
    for (const m of p.modules) placement.set(m.moduleId, m.placementCount);

  // What the index holds for these pages: a page whose document and
  // anchor texts come out the same is not written again (an edit of the
  // footer, which changes every page's HTML, writes nothing). Changes no
  // index holds yet make the comparison unsafe: then everything is written.
  const before = await pages.getMany(args.pages.map((p) => p.pageId));
  const trust = !before.pending;
  const storedChrome = trust ? await chromeDigests(ctx, moduleIds) : new Map<string, string>();

  const upserts = [];
  const excluded: string[] = [];
  const anchorDocs = new Map<string, ReturnType<typeof anchorDocuments>[number]>();
  const anchorSources = new Set<string>();
  const chrome = new Map<string, AnchorDoc[]>();
  const report = new Map<string, ModuleReportRow>();
  for (const facts of args.pages) {
    const all = anchorDocuments(facts, {
      chromeLinks: counting.chromeLinks,
      placementOf: (id) => placement.get(id) ?? 1,
    });
    const own = all.filter((d) => d.values.source === `p:${facts.pageId}`);
    for (const d of all)
      if (d.values.source.startsWith("m:")) {
        const list = chrome.get(d.values.source.slice(2)) ?? [];
        if (!list.some((x) => x.id === d.id)) list.push(d);
        chrome.set(d.values.source.slice(2), list);
      }
    for (const m of facts.modules)
      if (m.zone === "layout" && !chrome.has(m.moduleId)) chrome.set(m.moduleId, []);
    const anchorsDigest = digestOf(own.map((d) => [d.id, d.values.text]).sort());
    const old = before.docs.get(facts.pageId);
    const ownChanged = !trust || old?.values.anchors_digest !== anchorsDigest;
    const exclusion = pageExclusion(facts, {
      resultsPage,
      excluded: pageSettings.get(facts.pageId)?.excluded === true,
    });
    if (exclusion) {
      // No document keeps its anchor digest, so its texts are always rewritten.
      anchorSources.add(`p:${facts.pageId}`);
      for (const d of own) anchorDocs.set(d.id, d);
      if (!trust || old) excluded.push(facts.pageId);
      continue;
    }
    if (ownChanged) {
      anchorSources.add(`p:${facts.pageId}`);
      for (const d of own) anchorDocs.set(d.id, d);
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
        placement: m.contentPlacementCount,
        weighting: v.weighting,
        reason: v.reason,
      });
    }
    const doc = pageDocument(facts, verdicts);
    const digest = digestOf(doc.values);
    if (!trust || old?.values.digest !== digest || ownChanged)
      upserts.push({ ...doc, values: { ...doc.values, digest, anchors_digest: anchorsDigest } });
  }
  // A navigation block's links: replaced only when they changed.
  const chromeDigest = new Map<string, string>();
  for (const [moduleId, docs] of chrome) {
    const d = digestOf(docs.map((x) => [x.id, x.values.text, x.values.sources]).sort());
    chromeDigest.set(moduleId, d);
    if (!trust || storedChrome.get(moduleId) !== d) {
      anchorSources.add(`m:${moduleId}`);
      for (const x of docs) anchorDocs.set(x.id, x);
    }
  }
  for (const [moduleId, d] of chromeDigest) {
    const row = report.get(moduleId);
    if (row) report.set(moduleId, { ...row, anchorsDigest: d });
  }
  // The links of these pages and blocks replace what they said before, as
  // one change (the index removes, then adds).
  if (anchorSources.size > 0)
    await anchors.replace("source", [...anchorSources], [...anchorDocs.values()]);
  if (excluded.length > 0) await pages.delete(excluded);
  if (upserts.length > 0) await pages.upsert(upserts);

  const notes: string[] = [];
  if (args.final) {
    if (args.removed.length > 0) {
      await pages.delete(args.removed);
      await anchors.replace(
        "source",
        args.removed.map((id) => `p:${id}`),
        [],
      );
      await anchors.replace("target", args.removed, []);
    }
    const goneModules = args.placementChanges.filter((c) => c.after === 0);
    if (goneModules.length > 0)
      await anchors.replace(
        "source",
        goneModules.map((c) => `m:${c.moduleId}`),
        [],
      );
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
      // The pinned pages are checked by the Stage audit's test queries.
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
