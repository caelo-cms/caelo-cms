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
 */

import {
  type CollectionStore,
  FileCache,
  openRelease,
  parseRelease,
  prefixedCache,
  readProfile,
  scopedStore,
  storeFromUrl,
} from "@caelo-cms/collection-index";
import {
  isPluginDisabled,
  loadedPlugins,
  type OpenEntry,
  wasmQueryEmbedder,
} from "@caelo-cms/plugin-host/gateway";
import {
  type CollectionOperationManifest,
  collectionOperationManifest,
  searchProfile,
} from "@caelo-cms/plugin-sdk";
import type { DatabaseAdapter } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";

export { runCollectionOperation } from "@caelo-cms/plugin-host/gateway";

/** The env var of each environment's collection store. */
const STORE_ENV = {
  live: "CAELO_COLLECTIONS_LIVE_STORE",
  staging: "CAELO_COLLECTIONS_STAGING_STORE",
} as const;

/** Bytes of index files one gateway keeps parsed in memory (LRU). */
const CACHE_BYTES = Number(process.env.CAELO_COLLECTIONS_CACHE_MB ?? 256) * 1024 * 1024;

/** Releases one gateway keeps open (the newest few; a Publish live replaces one). */
const OPEN_RELEASES = 8;

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
        const profile = parsed?.success ? parsed.data : null;
        // The first semantic query should not also pay the model's load.
        if (profile?.semantic && manifest.vectorModel) {
          defaultQueryEmbedder().warm(manifest.vectorModel.id);
        }
        return { release, profile };
      })();
      entry.catch(() => this.open.delete(id));
      this.open.set(id, entry);
      while (this.open.size > OPEN_RELEASES)
        this.open.delete(this.open.keys().next().value as string);
    }
    return entry;
  }
}

let gatewayEmbedder: ReturnType<typeof wasmQueryEmbedder> | null = null;

/** The process's query embedder (one per gateway process). */
export function defaultQueryEmbedder(): ReturnType<typeof wasmQueryEmbedder> {
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
