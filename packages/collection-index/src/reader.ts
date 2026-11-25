// SPDX-License-Identifier: MPL-2.0

/**
 * Reading segments from a file source (epic #1644, R3).
 *
 * The gateway loads only the files a query needs and keeps them in a
 * bounded cache, so a cold instance pays for the shards of its first query,
 * never for the whole index. Jobs read the same way from local disk or the
 * private store.
 */

import type { KeyedDoc } from "./schema.js";
import {
  compareTerms,
  decodePostings,
  findInShard,
  type ParsedDocs,
  type ParsedShard,
  type PostingList,
  parseDocs,
  parseShard,
  parseStore,
  prefixInShard,
  type SegmentManifest,
  type TermInfo,
} from "./segment.js";
import { type CodeFile, parseCodeFile } from "./vectors.js";
import { decodeVocabulary, type VocabularyWord, vocabularyBucket } from "./vocabulary.js";

/** Where segment files come from: object storage, a local directory, a map in tests. */
export interface FileSource {
  read(file: string): Promise<Uint8Array>;
}

/** Counters a cache exposes, for the benchmark and the gateway's metrics. */
export interface CacheStats {
  hits: number;
  misses: number;
  bytesLoaded: number;
}

/** What readers need of a cache: a parsed file by name. */
export interface FileCacheLike {
  get<T>(file: string, parse: (data: Uint8Array) => T): Promise<T>;
}

/** A view of `cache` whose file names sit under `prefix/`: one bounded cache for many collections. */
export function prefixedCache(cache: FileCacheLike, prefix: string): FileCacheLike {
  return { get: (file, parse) => cache.get(`${prefix}/${file}`, parse) };
}

/**
 * Caches parsed files up to a byte budget, least recently used out first.
 * Values are parsed once; the budget counts the raw file size. Concurrent
 * requests for one file share one read.
 */
export class FileCache implements FileCacheLike {
  private readonly entries = new Map<string, { value: unknown; bytes: number }>();
  private readonly loading = new Map<string, Promise<unknown>>();
  private used = 0;
  readonly stats: CacheStats = { hits: 0, misses: 0, bytesLoaded: 0 };

  constructor(
    private readonly source: FileSource,
    private readonly budgetBytes: number,
  ) {}

  /** Bytes currently held. */
  get bytesHeld(): number {
    return this.used;
  }

  /** Loads and parses a file, or returns the cached parse. */
  get<T>(file: string, parse: (data: Uint8Array) => T): Promise<T> {
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
    const load = this.load(file, parse).finally(() => this.loading.delete(file));
    this.loading.set(file, load);
    return load;
  }

  private async load<T>(file: string, parse: (data: Uint8Array) => T): Promise<T> {
    const data = await this.source.read(file);
    this.stats.bytesLoaded += data.length;
    const value = parse(data);
    this.entries.set(file, { value, bytes: data.length });
    this.used += data.length;
    for (const [name, entry] of this.entries) {
      if (this.used <= this.budgetBytes) break;
      if (name === file) continue;
      this.entries.delete(name);
      this.used -= entry.bytes;
    }
    return value;
  }
}

/** One open segment. Cheap to create; files load on demand through the cache. */
export class SegmentReader {
  constructor(
    readonly manifest: SegmentManifest,
    private readonly cache: FileCacheLike,
  ) {}

  /** Keys, slot lengths, languages, numbers and facets of every document in the segment. */
  docs(): Promise<ParsedDocs> {
    return this.cache.get(this.manifest.docsFile, (d) => parseDocs(d, this.manifest));
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
    return this.cache.get((this.manifest.shards[index] as { file: string }).file, parseShard);
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

  /** Full documents by key. Every store file needed loads in parallel. */
  async stored(keys: readonly number[]): Promise<Map<number, KeyedDoc>> {
    const result = new Map<number, KeyedDoc>();
    const needed = this.manifest.stores.filter((store) =>
      keys.some((k) => k >= store.firstKey && k <= store.lastKey),
    );
    const loaded = await Promise.all(needed.map((store) => this.cache.get(store.file, parseStore)));
    const wanted = new Set(keys);
    for (const rows of loaded)
      for (const row of rows) if (wanted.has(row.key)) result.set(row.key, row);
    return result;
  }

  /** Every document of the segment, store file by store file: the rebuild source. */
  async *allStored(): AsyncGenerator<KeyedDoc> {
    for (const store of this.manifest.stores)
      for (const doc of await this.cache.get(store.file, parseStore)) yield doc;
  }

  /** Vocabulary words of this segment in the bucket of `initial`. */
  vocabulary(initial: string): Promise<VocabularyWord[]> {
    const file = this.manifest.vocabulary[vocabularyBucket(initial)];
    return file ? this.cache.get(file, decodeVocabulary) : Promise.resolve([]);
  }

  /** The binary code files of the vector field, empty without vectors. */
  codeFiles(): Promise<CodeFile[]> {
    const v = this.manifest.vectors;
    if (!v) return Promise.resolve([]);
    return Promise.all(
      v.codes.map((file) => this.cache.get(file, (d) => parseCodeFile(d, v.dims))),
    );
  }

  /** One int8 block of the vector field. */
  vectorBlock(index: number): Promise<Uint8Array> {
    const file = this.manifest.vectors?.blocks[index];
    if (!file) return Promise.reject(new RangeError(`vector block ${index} does not exist`));
    return this.cache.get(file, (d) => d);
  }
}
