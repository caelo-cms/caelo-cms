// SPDX-License-Identifier: MPL-2.0

/**
 * Reading segments from a file source (epic #1644, R3).
 *
 * Files load on demand through a bounded cache, so a query never needs
 * more than its own files and a large index never has to fit in memory.
 *
 * The bound is what the files hold once parsed (#1780), not their size on
 * disk: every file format here says how many bytes its parsed value costs.
 * Counting the file's bytes undercounted a parsed store file six times on
 * searchVIU's live index (deflated JSON becomes objects), so a "256 MB"
 * cache could hold well over 1.5 GB. Format-3 store blocks stay compressed
 * in the cache and decode only the documents a query asks for.
 *
 * A small segment is one packed file (#1781): it loads in one request, all
 * its parts parsed at once, and leaves the cache as one entry. The gateway
 * prefetches a release when it opens one (`prefetchRelease`, release.ts):
 * packs, and of larger segments what every query reads whatever it asks
 * (documents, vector codes or centroids, vocabulary), so a first search on
 * a cold instance waits for one round of reads, not one per file. Jobs read
 * the same way from local disk or the private store.
 */

import { inflateRawSync } from "node:zlib";
import {
  type Centroids,
  type ListFile,
  listVector,
  parseCentroids,
  parseList,
} from "./partitions.js";
import type { KeyedDoc } from "./schema.js";
import {
  compareTerms,
  decodePostings,
  docsBytes,
  findInShard,
  type ParsedDocs,
  type ParsedShard,
  type PostingList,
  parseDocs,
  parseShard,
  parseStoreBlock,
  prefixInShard,
  type SegmentManifest,
  type StoreBlock,
  shardBytes,
  storeBlockBytes,
  storeBlockDocs,
  stringBytes,
  type TermInfo,
  VECTORS_PER_BLOCK,
} from "./segment.js";
import { type CodeFile, type EncodedVector, parseCodeFile, storedVector } from "./vectors.js";
import { decodeVocabulary, type VocabularyWord, vocabularyBucket } from "./vocabulary.js";

/** Where segment files come from: object storage, a local directory, a map in tests. */
export interface FileSource {
  read(file: string): Promise<Uint8Array>;
}

/** Counters a cache exposes, for the benchmark and the gateway's metrics. */
export interface CacheStats {
  hits: number;
  misses: number;
  /** Bytes read from the source. */
  bytesRead: number;
  /** Bytes the loaded files hold parsed (what the budget counts). */
  bytesLoaded: number;
}

/** How a file is parsed and what its parsed value costs in memory. */
export interface FileFormat<T> {
  readonly parse: (data: Uint8Array) => T;
  /** Bytes `value` holds, as the cache's budget counts them. */
  readonly bytes: (value: T, data: Uint8Array) => number;
}

/** What readers need of a cache: a parsed file by name. */
export interface FileCacheLike {
  get<T>(file: string, format: FileFormat<T>): Promise<T>;
}

/** A view of `cache` whose file names sit under `prefix/`: one bounded cache for many collections. */
export function prefixedCache(cache: FileCacheLike, prefix: string): FileCacheLike {
  return { get: (file, format) => cache.get(`${prefix}/${file}`, format) };
}

/**
 * Caches parsed files up to a byte budget, least recently used out first.
 * Values are parsed once; the budget counts what each parsed value holds.
 * Concurrent requests for one file share one read.
 */
export class FileCache implements FileCacheLike {
  private readonly entries = new Map<string, { value: unknown; bytes: number }>();
  private readonly loading = new Map<string, Promise<unknown>>();
  private used = 0;
  readonly stats: CacheStats = { hits: 0, misses: 0, bytesRead: 0, bytesLoaded: 0 };

  constructor(
    private readonly source: FileSource,
    private readonly budgetBytes: number,
  ) {}

  /** Bytes currently held. */
  get bytesHeld(): number {
    return this.used;
  }

  /** Loads and parses a file, or returns the cached parse. */
  get<T>(file: string, format: FileFormat<T>): Promise<T> {
    const hit = this.entries.get(file);
    if (hit) {
      this.entries.delete(file);
      this.entries.set(file, hit);
      this.stats.hits++;
      return Promise.resolve(hit.value as T);
    }
    const pending = this.loading.get(file);
    if (pending) {
      this.stats.hits++;
      return pending as Promise<T>;
    }
    this.stats.misses++;
    const load = this.load(file, format).finally(() => this.loading.delete(file));
    this.loading.set(file, load);
    return load;
  }

  private async load<T>(file: string, format: FileFormat<T>): Promise<T> {
    const data = await this.source.read(file);
    this.stats.bytesRead += data.length;
    const value = format.parse(data);
    const bytes = format.bytes(value, data);
    this.stats.bytesLoaded += bytes;
    this.entries.set(file, { value, bytes });
    this.used += bytes;
    for (const [name, entry] of this.entries) {
      if (this.used <= this.budgetBytes) break;
      if (name === file) continue;
      this.entries.delete(name);
      this.used -= entry.bytes;
    }
    return value;
  }
}

const utf8Decoder = new TextDecoder();

/** JSON files (manifests, profiles): about twice their text, what the objects cost. */
export function jsonFormat<T>(): FileFormat<T> {
  return {
    parse: (d) => JSON.parse(utf8Decoder.decode(d)) as T,
    bytes: (_v, d) => 512 + d.length * 2,
  };
}

/** Raw bytes kept as loaded. */
export const RAW_FORMAT: FileFormat<Uint8Array> = {
  parse: (d) => d,
  bytes: (_v, d) => d.byteLength,
};

const SHARD_FORMAT: FileFormat<ParsedShard> = { parse: parseShard, bytes: (v) => shardBytes(v) };

const VOCABULARY_FORMAT: FileFormat<VocabularyWord[]> = {
  parse: decodeVocabulary,
  bytes: (words) => words.reduce((n, w) => n + 48 + stringBytes(w.word), 64),
};

/** A format-2 store file: the parsed documents, sized by their JSON text (#1780). */
interface LegacyStore {
  readonly docs: KeyedDoc[];
  readonly bytes: number;
}
const LEGACY_STORE_FORMAT: FileFormat<LegacyStore> = {
  parse: (d) => {
    const text = utf8Decoder.decode(inflateRawSync(d));
    // Measured on searchVIU's live index: parsed documents take about twice their JSON text.
    return { docs: JSON.parse(text) as KeyedDoc[], bytes: 1024 + text.length * 2 };
  },
  bytes: (v) => v.bytes,
};

const STORE_BLOCK_FORMAT: FileFormat<StoreBlock> = {
  parse: parseStoreBlock,
  bytes: (b) => storeBlockBytes(b),
};

function codeFormat(dims: number): FileFormat<CodeFile> {
  return {
    parse: (d) => parseCodeFile(d, dims),
    bytes: (c) => c.keys.byteLength + c.passages.byteLength + c.words.byteLength + 64,
  };
}

const CENTROIDS_FORMAT: FileFormat<Centroids> = {
  parse: parseCentroids,
  bytes: (c) => c.values.byteLength + 64,
};

function listFormat(dims: number): FileFormat<ListFile> {
  return {
    parse: (d) => parseList(d, dims),
    bytes: (l) =>
      l.keys.byteLength +
      l.passages.byteLength +
      l.scales.byteLength +
      l.int8.byteLength +
      l.codes.byteLength +
      64,
  };
}

/** One file of a segment, loaded (and parsed) into the cache by `load`. */
export interface FileLoad {
  readonly file: string;
  load(): Promise<unknown>;
}

/** A segment's packed parts, each parsed with its own format. */
type PackedParts = ReadonlyMap<string, unknown>;

/** One open segment. Cheap to create; files load on demand through the cache. */
export class SegmentReader {
  private readonly formats = new Map<string, FileFormat<unknown>>();

  constructor(
    readonly manifest: SegmentManifest,
    private readonly cache: FileCacheLike,
  ) {
    const m = manifest;
    const set = <T>(file: string, f: FileFormat<T>): void => {
      this.formats.set(file, f as FileFormat<unknown>);
    };
    set(m.docsFile, { parse: (d) => parseDocs(d, m), bytes: (v) => docsBytes(v) });
    for (const s of m.shards) set(s.file, SHARD_FORMAT);
    for (const s of m.stores) {
      if (m.format >= 3) set(s.file, STORE_BLOCK_FORMAT);
      else set(s.file, LEGACY_STORE_FORMAT);
    }
    for (const f of Object.values(m.vocabulary)) set(f, VOCABULARY_FORMAT);
    const v = m.vectors;
    if (v) {
      for (const f of v.codes) set(f, codeFormat(v.dims));
      for (const f of v.blocks) set(f, RAW_FORMAT);
      if (v.partitions) {
        set(v.partitions.centroids, CENTROIDS_FORMAT);
        for (const l of v.partitions.lists) set(l.file, listFormat(v.dims));
      }
    }
  }

  /** The pack, parsed part by part: one cache entry, one request. */
  private packed(): Promise<PackedParts> {
    const pack = this.manifest.pack as NonNullable<SegmentManifest["pack"]>;
    return this.cache
      .get<{ parts: PackedParts; bytes: number }>(pack.file, {
        parse: (data) => {
          const parts = new Map<string, unknown>();
          let bytes = 256;
          for (const [name, [offset, length]] of Object.entries(pack.parts)) {
            const format = this.formats.get(name);
            if (!format) throw new RangeError(`segment pack ${pack.file}: unknown part ${name}`);
            // A copy: the pack's buffer is freed once every part is parsed.
            const slice = data.slice(offset, offset + length);
            const value = format.parse(slice);
            parts.set(name, value);
            bytes += format.bytes(value, slice);
          }
          return { parts, bytes };
        },
        bytes: (v) => v.bytes,
      })
      .then((v) => v.parts);
  }

  /** One file of the segment, parsed with its format. */
  private file<T>(name: string): Promise<T> {
    const pack = this.manifest.pack;
    if (pack && name in pack.parts) return this.packed().then((parts) => parts.get(name) as T);
    const format = this.formats.get(name);
    if (!format)
      return Promise.reject(new RangeError(`segment: ${name} is not a file of this segment`));
    return this.cache.get(name, format as FileFormat<T>);
  }

  /** Keys, slot lengths, languages, numbers, facets and columns of every document in the segment. */
  docs(): Promise<ParsedDocs> {
    return this.file(this.manifest.docsFile);
  }

  private shardIndexFor(term: string): number {
    const shards = this.manifest.shards;
    let lo = 0;
    let hi = shards.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = shards[mid] as (typeof shards)[number];
      if (compareTerms(term, s.first) < 0) hi = mid - 1;
      else if (compareTerms(term, s.last) > 0) lo = mid + 1;
      else return mid;
    }
    return -1;
  }

  private shard(index: number): Promise<ParsedShard> {
    return this.file((this.manifest.shards[index] as { file: string }).file);
  }

  /** The postings of one term, or null when the segment does not contain it. */
  async postings(term: string): Promise<PostingList | null> {
    const index = this.shardIndexFor(term);
    if (index < 0) return null;
    const entry = findInShard(await this.shard(index), term);
    return entry ? decodePostings(entry.postings, entry.df, this.manifest.slots.length) : null;
  }

  /** Terms that start with `prefix`, most frequent first, at most `limit`. */
  async termsWithPrefix(prefix: string, limit: number): Promise<TermInfo[]> {
    const shards = this.manifest.shards;
    const wanted: number[] = [];
    for (let i = 0; i < shards.length; i++) {
      const s = shards[i] as (typeof shards)[number];
      if (compareTerms(s.last, prefix) < 0) continue;
      if (compareTerms(s.first, prefix) > 0 && !s.first.startsWith(prefix)) break;
      wanted.push(i);
    }
    const found = await Promise.all(
      wanted.map(async (i) => prefixInShard(await this.shard(i), prefix)),
    );
    return found
      .flat()
      .sort((a, b) => b.df - a.df || compareTerms(a.term, b.term))
      .slice(0, limit);
  }

  /** The documents of one store file, all of them or those `wanted` accepts. */
  private async storeDocs(file: string, wanted?: (key: number) => boolean): Promise<KeyedDoc[]> {
    if (this.manifest.format >= 3) return storeBlockDocs(await this.file<StoreBlock>(file), wanted);
    const docs = (await this.file<LegacyStore>(file)).docs;
    return wanted ? docs.filter((d) => wanted(d.key)) : docs;
  }

  /** Full documents by key. Every store file needed loads in parallel; only wanted documents are decoded. */
  async stored(keys: readonly number[]): Promise<Map<number, KeyedDoc>> {
    const result = new Map<number, KeyedDoc>();
    const wanted = new Set(keys);
    const needed = this.manifest.stores.filter((store) =>
      keys.some((k) => k >= store.firstKey && k <= store.lastKey),
    );
    const loaded = await Promise.all(
      needed.map((s) => this.storeDocs(s.file, (k) => wanted.has(k))),
    );
    for (const docs of loaded) for (const d of docs) result.set(d.key, d);
    return result;
  }

  /** Every document of the segment, store file by store file: the rebuild source. */
  async *allStored(): AsyncGenerator<KeyedDoc> {
    for (const store of this.manifest.stores)
      for (const doc of await this.storeDocs(store.file)) yield doc;
  }

  /** Vocabulary words of this segment in the bucket of `initial`. */
  vocabulary(initial: string): Promise<VocabularyWord[]> {
    const file = this.manifest.vocabulary[vocabularyBucket(initial)];
    return file ? this.file(file) : Promise.resolve([]);
  }

  /** The binary code files of a flat vector field, empty without vectors or when partitioned. */
  codeFiles(): Promise<CodeFile[]> {
    const v = this.manifest.vectors;
    if (!v) return Promise.resolve([]);
    return Promise.all(v.codes.map((file) => this.file<CodeFile>(file)));
  }

  /** One int8 block of a flat vector field. */
  vectorBlock(index: number): Promise<Uint8Array> {
    const file = this.manifest.vectors?.blocks[index];
    if (!file) return Promise.reject(new RangeError(`vector block ${index} does not exist`));
    return this.file(file);
  }

  /** The centroids of a partitioned vector field. */
  centroids(): Promise<Centroids> {
    const p = this.manifest.vectors?.partitions;
    if (!p) return Promise.reject(new RangeError("segment: its vectors are not partitioned"));
    return this.file(p.centroids);
  }

  /** One list of a partitioned vector field. */
  list(index: number): Promise<ListFile> {
    const file = this.manifest.vectors?.partitions?.lists[index]?.file;
    if (!file) return Promise.reject(new RangeError(`vector list ${index} does not exist`));
    return this.file(file);
  }

  /**
   * The stored encodings of the segment's vectors by document key and
   * passage, for every document or only `keys`: what a merge carries over
   * and a Stage reuses, never re-embedding.
   */
  async vectorsOf(
    keys: ReadonlySet<number> | null,
  ): Promise<Map<number, (EncodedVector | null)[]>> {
    const out = new Map<number, (EncodedVector | null)[]>();
    const v = this.manifest.vectors;
    if (!v) return out;
    const put = (key: number, passage: number, e: EncodedVector): void => {
      const list = out.get(key) ?? out.set(key, []).get(key);
      if (list) list[passage] = e;
    };
    if (v.partitions) {
      for (let li = 0; li < v.partitions.lists.length; li++) {
        const list = await this.list(li);
        for (let r = 0; r < list.count; r++) {
          const key = list.keys[r] as number;
          if (keys && !keys.has(key)) continue;
          put(key, list.passages[r] as number, listVector(list, r, v.dims));
        }
      }
      return out;
    }
    const files = await this.codeFiles();
    let ordinal = 0;
    for (const f of files) {
      for (let i = 0; i < f.count; i++, ordinal++) {
        const key = f.keys[i] as number;
        if (keys && !keys.has(key)) continue;
        const block = await this.vectorBlock(Math.floor(ordinal / VECTORS_PER_BLOCK));
        put(
          key,
          f.passages[i] as number,
          storedVector(f, i, block, ordinal % VECTORS_PER_BLOCK, v.dims),
        );
      }
    }
    return out;
  }

  /**
   * The loads a prefetch makes, in the order queries reach for them: [0]
   * the pack (a small segment, everything) or the documents file, [1] the
   * vector codes or centroids, [2] the vocabulary (typos, prefixes). Term
   * shards, stored documents, int8 blocks and vector lists depend on what a
   * query asks and load when it asks.
   */
  fileLoads(): readonly (readonly FileLoad[])[] {
    const m = this.manifest;
    if (m.pack) return [[{ file: m.pack.file, load: () => this.packed() }]];
    const v = m.vectors;
    const vectorFiles = v?.partitions ? [v.partitions.centroids] : (v?.codes ?? []);
    return [
      [{ file: m.docsFile, load: () => this.docs() }],
      vectorFiles.map((file) => ({ file, load: () => this.file(file) })),
      [...new Set(Object.values(m.vocabulary))].map((file) => ({
        file,
        load: () => this.file(file),
      })),
    ];
  }
}
