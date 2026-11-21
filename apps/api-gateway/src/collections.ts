// SPDX-License-Identifier: MPL-2.0

/**
 * Declarative collection operations in the gateway (epic #1644, R3, issue
 * #1649): `search`, `suggest` and `read`, executed by core code with the
 * collection engine. No plugin code runs here: the operation's declaration
 * and the collection's release (index files and search profile) are data.
 *
 *   GET /api/plugin/<slug>/<op>?release=<key>&…   the answer
 *   GET /api/plugin/<slug>/<op>/release            the current release key (no-store)
 *
 * An answer to a request that names the current release is cacheable
 * (`public, s-maxage`): the CDN serves a repeated query without waking the
 * gateway, and the next Stage's Publish live is a new key, so a cached
 * answer never outlives its index. A request naming another release gets
 * 409 with the current key; one naming none gets the answer uncached. No
 * cookie is read or set on these routes.
 *
 * Each gateway reads only its own environment's store: the live gateway
 * the live store, the staging gateway the staging one (the env var it is
 * given and its identity's bucket rights both say so).
 */

import {
  analyze,
  type CollectionStore,
  FileCache,
  foldDiacritics,
  highlight,
  idTerm,
  type KeyedDoc,
  keywordTerm,
  lookupDocs,
  type OpenRelease,
  openRelease,
  type Passage,
  parseRelease,
  prefixedCache,
  primaryLanguage,
  readProfile,
  scopedStore,
  searchText,
  snippet,
  storeFromUrl,
  type TextQuery,
} from "@caelo-cms/collection-index";
import { isPluginDisabled, loadedPlugins } from "@caelo-cms/plugin-host";
import {
  type CollectionOperationManifest,
  collectionOperationManifest,
  type SearchProfile,
  searchProfile,
} from "@caelo-cms/plugin-sdk";
import type { DatabaseAdapter } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";

/** The env var of each environment's collection store. */
const STORE_ENV = {
  live: "CAELO_COLLECTIONS_LIVE_STORE",
  staging: "CAELO_COLLECTIONS_STAGING_STORE",
} as const;

/** Bytes of index files one gateway keeps parsed in memory (LRU). */
const CACHE_BYTES = Number(process.env.CAELO_COLLECTIONS_CACHE_MB ?? 256) * 1024 * 1024;

/** Releases one gateway keeps open (the newest few; a Publish live replaces one). */
const OPEN_RELEASES = 8;

/** Words a query may have; more is refused, not cut. */
export const MAX_QUERY_WORDS = 10;

const PATH = /^\/api\/plugin\/([a-z][a-z0-9-]{0,54})\/([a-z_][a-z0-9_]{0,119})(\/release)?$/;

/** A collection-operation route, or null. */
export function parseCollectionPath(
  pathname: string,
): { slug: string; operation: string; releaseOnly: boolean } | null {
  const m = PATH.exec(pathname);
  if (!m) return null;
  return { slug: m[1] as string, operation: m[2] as string, releaseOnly: m[3] !== undefined };
}

/** One answer of the module: a status, a JSON body and how it may be cached. */
export interface CollectionAnswer {
  readonly status: number;
  readonly body: unknown;
  /** Seconds the CDN may keep it; null: no-store. */
  readonly cacheSeconds: number | null;
}

interface OpenEntry {
  readonly release: OpenRelease;
  readonly profile: SearchProfile | null;
}

/** The gateway's collection state: the store, the published release keys and the open releases. */
export class GatewayCollections {
  private store: CollectionStore | null = null;
  private readonly cache: FileCache;
  private published: Map<string, string> | null = null;
  private readonly open = new Map<string, Promise<OpenEntry>>();

  constructor(
    private readonly environment: "live" | "staging",
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
  ) {
    this.cache = new FileCache({ read: (f) => this.storeOrThrow().read(f) }, CACHE_BYTES);
  }

  private storeOrThrow(): CollectionStore {
    if (!this.store) {
      const url = this.env[STORE_ENV[this.environment]];
      if (!url)
        throw new Error(
          `${STORE_ENV[this.environment]} is not set: the ${this.environment} gateway has no collection store`,
        );
      this.store = storeFromUrl(url);
    }
    return this.store;
  }

  /** Forget the published keys (a publish notification); open releases stay, they are immutable. */
  invalidate(): void {
    this.published = null;
  }

  /** The published release key of each `pluginId:collection`. */
  async releaseKeys(
    adapter: DatabaseAdapter,
    ctx: { actorId: string; actorKind: "system"; requestId: string },
    mayCache: () => boolean,
  ): Promise<Map<string, string>> {
    if (this.published) return this.published;
    const rows = (await adapter.withPublicTransaction(ctx, async (tx) =>
      tx.execute(
        sql`SELECT plugin_id::text AS plugin_id, collection, release_key FROM published_collections`,
      ),
    )) as unknown as { plugin_id: string; collection: string; release_key: string }[];
    const keys = new Map<string, string>();
    // cms_public is attacker-writable (#635): only well-formed names reach the store.
    for (const r of rows) {
      if (
        /^[0-9a-f-]{36}$/.test(r.plugin_id) &&
        /^[a-z][a-z0-9_]{0,39}$/.test(r.collection) &&
        /^release-[0-9a-f]{24}\.json$/.test(r.release_key)
      ) {
        keys.set(`${r.plugin_id}:${r.collection}`, r.release_key);
      }
    }
    if (mayCache()) this.published = keys;
    return keys;
  }

  /** The open release (and its profile) of a plugin's collection under `releaseKey`. */
  release(slug: string, collection: string, releaseKey: string): Promise<OpenEntry> {
    const id = `${slug}/${collection}/${releaseKey}`;
    let entry = this.open.get(id);
    if (!entry) {
      const prefix = `${slug}/${collection}`;
      // One bounded cache of parsed files for every collection and release:
      // releases share most of their files, and the budget bounds memory.
      const cache = prefixedCache(this.cache, prefix);
      entry = (async () => {
        const scoped = scopedStore(this.storeOrThrow(), prefix);
        const manifest = parseRelease(await scoped.read(releaseKey));
        const release = await openRelease(manifest, cache);
        const raw = await readProfile(manifest, cache);
        const parsed = raw === null ? null : searchProfile.safeParse(raw);
        return { release, profile: parsed?.success ? parsed.data : null };
      })();
      entry.catch(() => this.open.delete(id));
      this.open.set(id, entry);
      while (this.open.size > OPEN_RELEASES)
        this.open.delete(this.open.keys().next().value as string);
    }
    return entry;
  }
}

function fail(status: number, kind: string, message: string): CollectionAnswer {
  return { status, body: { ok: false, error: { kind, message } }, cacheSeconds: null };
}

/** A language tag the engine accepts. */
function languageOf(raw: string | null): string | null {
  if (raw === null) return null;
  return /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{1,8})*$/.test(raw) ? raw.toLowerCase() : null;
}

/** The text a best bet is matched on: folded words, single-spaced. */
export function normalizeQuery(text: string, lang: string): string {
  return analyze(text, lang, { keepStopwords: true })
    .map((t) => t.exact)
    .join(" ");
}

function returned(doc: KeyedDoc, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { id: doc.id, lang: doc.lang };
  for (const f of fields) if (f in doc.values) out[f] = doc.values[f];
  return out;
}

function synonymsOf(profile: SearchProfile, lang: string): ReadonlyMap<string, readonly string[]> {
  const table = profile.synonyms[primaryLanguage(lang)] ?? {};
  return new Map(
    Object.entries(table).map(([w, alts]) => [foldDiacritics(w.toLowerCase()), alts] as const),
  );
}

/** Runs one declared operation against an open release. */
export async function runCollectionOperation(
  op: CollectionOperationManifest,
  entry: OpenEntry,
  releaseKey: string,
  params: URLSearchParams,
): Promise<CollectionAnswer> {
  const { release, profile } = entry;
  if (op.kind === "read") {
    const value = op.by === "id" ? params.get("id") : params.get("value");
    if (!value || value.length > 500)
      return fail(400, "InvalidInput", `pass ${op.by === "id" ? "id" : "value"}`);
    const docs = (
      await lookupDocs(release, [op.by === "id" ? idTerm(value) : keywordTerm(op.by, value)])
    ).slice(0, op.maxDocuments);
    const anchor = params.get("passage");
    return {
      status: 200,
      cacheSeconds: op.cacheSeconds,
      body: {
        release: releaseKey,
        documents: docs.map((d) => {
          const out = returned(d, op.returns);
          if (op.passages) {
            const all = (d.values[op.passages] ?? []) as Passage[];
            out[op.passages] = anchor ? all.filter((p) => p.anchor === anchor) : all;
          }
          return out;
        }),
      },
    };
  }
  if (!profile)
    return fail(
      503,
      "ProfileMissing",
      "the collection has no search profile yet: the plugin sets it at the next Stage",
    );
  const lang = languageOf(params.get("lang"));
  if (!lang) return fail(400, "InvalidInput", "pass lang, the visitor's language tag (e.g. de)");
  const q = (params.get("q") ?? "").trim();
  if (q.length > (op.kind === "search" ? op.maxQueryChars : 120))
    return fail(400, "InvalidInput", "the query is too long");
  if (analyze(q, lang).length > MAX_QUERY_WORDS)
    return fail(400, "InvalidInput", `at most ${MAX_QUERY_WORDS} words`);
  const langFilter =
    op.kind === "search" && op.language === "visitor" && !profile.crossLanguage
      ? [lang]
      : undefined;

  if (op.kind === "suggest") {
    const curated = profile.suggestions[primaryLanguage(lang)] ?? [];
    const folded = foldDiacritics(q.toLowerCase());
    const queries = (
      q === ""
        ? curated
        : curated.filter(
            (s) =>
              foldDiacritics(s.text.toLowerCase())
                .split(/\s+/)
                .some((w) => w.startsWith(folded)) ||
              foldDiacritics(s.text.toLowerCase()).startsWith(folded),
          )
    ).slice(0, op.maxResults);
    let docs: Record<string, unknown>[] = [];
    if (q !== "" && profile.prefix) {
      const r = await searchText(release, {
        text: q,
        lang,
        weights: profile.weights,
        limit: op.maxResults,
        prefix: true,
        typos: false,
        compounds: profile.compounds,
        synonyms: synonymsOf(profile, lang),
        protectedTerms: new Set(profile.protectedTerms),
        filter: { langs: [lang] },
      });
      docs = await storedOf(
        release,
        r.hits.map((h) => h.key),
        op.returns,
      );
    }
    return {
      status: 200,
      cacheSeconds: op.cacheSeconds,
      body: { release: releaseKey, queries, docs },
    };
  }

  // search
  if (q === "") return fail(400, "InvalidInput", "pass q, the query");
  const limit = Math.min(Number.parseInt(params.get("limit") ?? "10", 10) || 10, op.maxResults);
  const page = Math.max(1, Math.min(Number.parseInt(params.get("page") ?? "1", 10) || 1, 50));
  const keywords: Record<string, string[]> = {};
  for (const f of op.filters) {
    const values = params
      .getAll(`f.${f}`)
      .filter((v) => v.length <= 200)
      .slice(0, 20);
    if (values.length > 0) keywords[f] = values;
  }
  const ranges: Record<string, { gte?: number; lte?: number }> = {};
  for (const f of op.ranges) {
    const gte = Number(params.get(`min.${f}`) ?? Number.NaN);
    const lte = Number(params.get(`max.${f}`) ?? Number.NaN);
    if (Number.isFinite(gte) || Number.isFinite(lte))
      ranges[f] = {
        ...(Number.isFinite(gte) ? { gte } : {}),
        ...(Number.isFinite(lte) ? { lte } : {}),
      };
  }
  const query: TextQuery = {
    text: q,
    lang,
    weights: profile.weights,
    limit: limit * page * (profile.boosts.length > 0 ? 3 : 1),
    facets: op.facets,
    typos: profile.typos,
    compounds: profile.compounds,
    synonyms: synonymsOf(profile, lang),
    protectedTerms: new Set(profile.protectedTerms.map((t) => foldDiacritics(t.toLowerCase()))),
    filter: { ...(langFilter ? { langs: langFilter } : {}), keywords, ranges },
  };
  const r = await searchText(release, query);
  let keys = r.hits.map((h) => h.key);
  // Boosts reorder by stored keyword values, so the candidates load first.
  let stored = await storedMap(release, keys);
  if (profile.boosts.length > 0) {
    const score = new Map(r.hits.map((h) => [h.key, h.score] as const));
    const boosted = (k: number): number => {
      const doc = stored.get(k);
      let s = score.get(k) ?? 0;
      for (const b of profile.boosts) {
        const v = doc?.values[b.field];
        for (const value of Array.isArray(v) ? v : [v])
          if (typeof value === "string" && b.values[value] !== undefined)
            s *= b.values[value] as number;
      }
      return s;
    };
    keys = [...keys].sort((a, b) => boosted(b) - boosted(a) || a - b);
  }
  // Best bets: the documents the operator pinned for this query come first, in order.
  const pinnedIds =
    (profile.bestBets[primaryLanguage(lang)] ?? []).find(
      (b) => normalizeQuery(b.query, lang) === normalizeQuery(q, lang),
    )?.ids ?? [];
  const pinnedDocs = pinnedIds.length > 0 ? await lookupDocs(release, pinnedIds.map(idTerm)) : [];
  const pinnedOrder = pinnedIds
    .map((id) => pinnedDocs.find((d) => d.id === id))
    .filter((d): d is KeyedDoc => d !== undefined);
  for (const d of pinnedOrder) stored.set(d.key, d);
  const ordered = [
    ...pinnedOrder.map((d) => d.key),
    ...keys.filter((k) => !pinnedOrder.some((d) => d.key === k)),
  ];
  const pageKeys = ordered.slice((page - 1) * limit, page * limit);
  stored = stored.size >= pageKeys.length ? stored : await storedMap(release, pageKeys);
  const hits = pageKeys
    .map((k) => stored.get(k))
    .filter((d): d is KeyedDoc => d !== undefined)
    .map((d) => {
      const out = returned(d, op.returns);
      if (typeof d.values.title === "string" && op.returns.includes("title"))
        out.titleHighlights = highlight(d.values.title, r.terms, d.lang).highlights;
      if (op.snippet)
        out.snippet = snippet((d.values[op.snippet] ?? []) as Passage[], r.terms, d.lang);
      if (pinnedOrder.some((p) => p.key === d.key)) out.pinned = true;
      return out;
    });
  return {
    status: 200,
    cacheSeconds: op.cacheSeconds,
    body: {
      release: releaseKey,
      query: q,
      total: r.total + pinnedOrder.filter((d) => !keys.includes(d.key)).length,
      page,
      hits,
      facets: r.facets,
      corrections: r.corrections,
      splits: r.splits,
    },
  };
}

async function storedMap(
  release: OpenRelease,
  keys: readonly number[],
): Promise<Map<number, KeyedDoc>> {
  const out = new Map<number, KeyedDoc>();
  for (const seg of release.segments) {
    const want = keys.filter(
      (k) =>
        !seg.removed.has(k) &&
        k >= seg.reader.manifest.firstKey &&
        k <= seg.reader.manifest.lastKey &&
        !out.has(k),
    );
    if (want.length === 0) continue;
    for (const [k, d] of await seg.reader.stored(want)) if (!seg.removed.has(k)) out.set(k, d);
  }
  return out;
}

async function storedOf(
  release: OpenRelease,
  keys: readonly number[],
  fields: readonly string[],
): Promise<Record<string, unknown>[]> {
  const map = await storedMap(release, keys);
  return keys
    .map((k) => map.get(k))
    .filter((d): d is KeyedDoc => d !== undefined)
    .map((d) => returned(d, fields));
}

/** The declared operation of an active plugin, re-validated (the gateway trusts no published data blindly). */
export function declaredCollectionOperation(
  slug: string,
  operation: string,
): { pluginId: string; op: CollectionOperationManifest } | null {
  const plugin = loadedPlugins.bySlug(slug);
  if (!plugin || isPluginDisabled(slug)) return null;
  const raw = (plugin.definition.collectionOperations ?? []).find((o) => o.name === operation);
  if (!raw) return null;
  const parsed = collectionOperationManifest.safeParse(raw);
  if (!parsed.success || !plugin.definition.collections?.[parsed.data.collection]) return null;
  return { pluginId: plugin.pluginId, op: parsed.data };
}

/** Whether any active plugin declares a collection operation. */
export function servesCollectionOperations(): boolean {
  return loadedPlugins
    .all()
    .some((p) => (p.definition.collectionOperations ?? []).length > 0 && !isPluginDisabled(p.slug));
}
