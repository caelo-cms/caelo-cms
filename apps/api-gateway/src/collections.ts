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
 *
 * Semantic search (#1650): when the release was built with a catalog model
 * and the profile turns `semantic` on, `search` embeds the query with the
 * same model on ONNX Runtime's WebAssembly build (no native code touches a
 * visitor's text), ranks passages by cosine similarity (at least the
 * profile's `minSimilarity`), and fuses that ranking with the word ranking
 * by Reciprocal Rank Fusion (k = 60, the vector side weighted by the
 * profile's `weight`). Boosts and best bets apply to the fused order;
 * facets count the word matches. A release whose model this gateway's
 * catalog lacks answers 503 instead of a search without its meaning half.
 *
 * Warm-up (#1745): a cold instance's first search on searchVIU took
 * 11 s, and one lost its instance after 9 s, because it opened the release,
 * read about 130 index files one by one from object storage and loaded
 * the query model, all inside the visitor's search. {@link
 * GatewayCollections.warm} does that work ahead of the search, inside a
 * request: `/release` (asked when the visitor focuses the search field)
 * waits for it, and the admin's refresh ping after a publish opens the new
 * releases. Never after an answer: the gateway runs on request-billed CPU,
 * so work left running after the response waits for the next request.
 */

import {
  type CollectionStore,
  FileCache,
  openRelease,
  parseRelease,
  prefetchRelease,
  prefixedCache,
  readProfile,
  scopedStore,
  storeFromUrl,
} from "@caelo-cms/collection-index";
import {
  isPluginDisabled,
  loadedPlugins,
  ModelUnavailableError,
  type OpenEntry,
  type WarmableQueryEmbedder,
  wasmQueryEmbedder,
} from "@caelo-cms/plugin-host/gateway";
import {
  type CollectionOperationManifest,
  collectionOperationManifest,
  searchProfile,
} from "@caelo-cms/plugin-sdk";
import type { DatabaseAdapter } from "@caelo-cms/query-api";
import { COLLECTIONS_CACHE_MB_DEFAULT } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";

export { runCollectionOperation } from "@caelo-cms/plugin-host/gateway";

/** The env var of each environment's collection store. */
const STORE_ENV = {
  live: "CAELO_COLLECTIONS_LIVE_STORE",
  staging: "CAELO_COLLECTIONS_STAGING_STORE",
} as const;

/** Bytes of index files one gateway keeps parsed in memory (LRU), from `CAELO_COLLECTIONS_CACHE_MB`. */
function cacheBytes(env: Readonly<Record<string, string | undefined>>): number {
  return Number(env.CAELO_COLLECTIONS_CACHE_MB ?? COLLECTIONS_CACHE_MB_DEFAULT) * 1024 * 1024;
}

/** Releases one gateway keeps open (the newest few; a Publish live replaces one). */
const OPEN_RELEASES = 8;

/**
 * The share of the cache's budget one release's prefetch may load from the
 * store. Files the cache already holds (most of them, after a Publish live:
 * a new release shares its older segments) cost nothing. The rest stays for
 * what queries load on demand, so a release larger than the cache keeps
 * its documents and term shards (prefetched first) without pushing out
 * everything the last queries read.
 */
const PREFETCH_BUDGET_SHARE = 0.5;

const PATH = /^\/api\/plugin\/([a-z][a-z0-9-]{0,54})\/([a-z_][a-z0-9_]{0,119})(\/release)?$/;

/** A collection-operation route, or null. */
export function parseCollectionPath(
  pathname: string,
): { slug: string; operation: string; releaseOnly: boolean } | null {
  const m = PATH.exec(pathname);
  if (!m) return null;
  return { slug: m[1] as string, operation: m[2] as string, releaseOnly: m[3] !== undefined };
}

/** The gateway's collection state: the store, the published release keys and the open releases. */
export class GatewayCollections {
  private store: CollectionStore | null = null;
  private readonly cache: FileCache;
  private readonly cacheBytes: number;
  private published: Map<string, string> | null = null;
  private readonly open = new Map<string, Promise<OpenEntry>>();
  /** The prefetch of each open release, run once (keyed like {@link open}). */
  private readonly prefetched = new Map<string, Promise<void>>();

  constructor(
    private readonly environment: "live" | "staging",
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
  ) {
    this.cacheBytes = cacheBytes(env);
    this.cache = new FileCache({ read: (f) => this.storeOrThrow().read(f) }, this.cacheBytes);
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
    const id = releaseId(slug, collection, releaseKey);
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
        const profile = parsed?.success ? parsed.data : null;
        return { release, profile };
      })();
      entry.catch(() => {
        this.open.delete(id);
        this.prefetched.delete(id);
      });
      this.open.set(id, entry);
      while (this.open.size > OPEN_RELEASES) {
        const oldest = this.open.keys().next().value as string;
        this.open.delete(oldest);
        this.prefetched.delete(oldest);
      }
    }
    return entry;
  }

  /**
   * Readies one release for queries: opens it, loads its index files into
   * the cache (up to {@link PREFETCH_BUDGET_SHARE} of it, the files every
   * query needs first) and, given an `embedder`, loads the query model the
   * release's profile searches by meaning with. The index comes first: the
   * model's load is CPU-bound and holds the event loop for part of it, and
   * a suggestion needs only the index.
   *
   * Concurrent callers share one open and one prefetch; the model's load is
   * shared by the embedder. Never rejects: a failure is logged, and the
   * query that needs the file or the model fails loudly itself.
   */
  async warm(
    slug: string,
    collection: string,
    releaseKey: string,
    options: { readonly embedder?: WarmableQueryEmbedder } = {},
  ): Promise<void> {
    const id = releaseId(slug, collection, releaseKey);
    let entry: OpenEntry;
    try {
      entry = await this.release(slug, collection, releaseKey);
    } catch (e) {
      console.error(`[api-gateway] collection ${id}: could not be opened: ${messageOf(e)}`);
      return;
    }
    let prefetch = this.prefetched.get(id);
    if (!prefetch) {
      const started = performance.now();
      // What this prefetch loads, measured on the cache's counter (a query
      // loading beside it counts too, which errs on the side of less).
      const loadedBefore = this.cache.stats.bytesLoaded;
      prefetch = prefetchRelease(entry.release, {
        mayLoad: () =>
          this.cache.stats.bytesLoaded - loadedBefore < this.cacheBytes * PREFETCH_BUDGET_SHARE,
      }).then((r) => {
        const line = `[api-gateway] collection ${id}: ${r.files} index files in memory after ${Math.round(performance.now() - started)} ms (cache ${Math.round(this.cache.bytesHeld / 1048576)} MiB)${r.skipped > 0 ? `, ${r.skipped} left to load on demand (the cache's prefetch share is full)` : ""}`;
        if (r.failed > 0) console.error(`${line}, ${r.failed} unreadable (first: ${r.firstError})`);
        else console.log(line);
      });
      // Only an open release keeps its prefetch (release() evicts both).
      if (this.open.has(id)) this.prefetched.set(id, prefetch);
    }
    await prefetch;
    const model = entry.release.manifest.vectorModel?.id;
    if (options.embedder && model && entry.profile?.semantic) {
      // The embedder logs a load and its failure; a model the catalog lacks
      // never starts loading, so that one is said here.
      await options.embedder.ready(model).catch((e: unknown) => {
        if (e instanceof ModelUnavailableError) {
          console.error(`[api-gateway] collection ${id}: ${e.message}`);
        }
      });
    }
  }

  /**
   * Readies the releases one declared operation answers from: its
   * collection's and, for a search over link texts, the anchor
   * collection's. A collection with no published release is skipped (its
   * query answers IndexNotReady).
   */
  async warmOperation(
    declared: {
      readonly slug: string;
      readonly pluginId: string;
      readonly op: CollectionOperationManifest;
    },
    keys: ReadonlyMap<string, string>,
    options: { readonly embedder?: WarmableQueryEmbedder } = {},
  ): Promise<void> {
    const { slug, pluginId, op } = declared;
    const collections = [op.collection];
    if (op.kind === "search" && op.anchors) collections.push(op.anchors.collection);
    await Promise.all(
      collections.map((c) => {
        const key = keys.get(`${pluginId}:${c}`);
        return key ? this.warm(slug, c, key, options) : undefined;
      }),
    );
  }
}

function releaseId(slug: string, collection: string, releaseKey: string): string {
  return `${slug}/${collection}/${releaseKey}`;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Whether `work` settles within `ms`. Bounds a warm-up inside a request: past
 * the bound the request answers anyway, and what is still loading is shared
 * with the query that needs it.
 */
export async function settlesWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<false>((done) => {
    timer = setTimeout(() => done(false), ms);
  });
  try {
    return await Promise.race([work.then(() => true as const), bound]);
  } finally {
    clearTimeout(timer);
  }
}

let gatewayEmbedder: WarmableQueryEmbedder | null = null;

/** The process's query embedder (one per gateway process). */
export function defaultQueryEmbedder(): WarmableQueryEmbedder {
  gatewayEmbedder ??= wasmQueryEmbedder();
  return gatewayEmbedder;
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

/** Every declared operation of every active plugin, re-validated like {@link declaredCollectionOperation}. */
export function declaredCollectionOperations(): {
  slug: string;
  pluginId: string;
  op: CollectionOperationManifest;
}[] {
  const out: { slug: string; pluginId: string; op: CollectionOperationManifest }[] = [];
  for (const plugin of loadedPlugins.all()) {
    for (const raw of plugin.definition.collectionOperations ?? []) {
      const declared = declaredCollectionOperation(plugin.slug, raw.name);
      if (declared) out.push({ slug: plugin.slug, ...declared });
    }
  }
  return out;
}
