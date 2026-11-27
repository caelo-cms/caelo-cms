// SPDX-License-Identifier: MPL-2.0

/**
 * The segment file format (epic #1644, R2) and its readers.
 *
 * A segment is a set of content-addressed files named in its manifest:
 *
 * - term shards: a slice of the sorted dictionary with its postings;
 * - one docs file: keys, slot lengths (BM25F), languages, number values
 *   and facet ordinals, all positional by document;
 * - store files: the full documents, deflate-compressed, a few dozen each;
 * - vector files (optional): binary codes for every passage, plus int8
 *   blocks for rescoring; or, in a large segment, partitions (#1783,
 *   partitions.ts): centroids and lists of int8 vectors with their codes.
 *
 * Format 3 (#1780, #1781): a store file is compressed as one block, about
 * {@link STORE_BLOCK_BYTES} of documents, behind a table of each
 * document's key, offset and length, so a reader decodes the documents a
 * query asks for and the cache holds the compressed bytes; `columns` are
 * keyword fields stored per document in the docs file (like facets) for
 * operations that read a value per hit; and a segment of at most
 * `PACK_MAX_BYTES` is one packed file (`pack`): its parts by name with
 * their offsets, read in one request. Readers keep reading format 2 (the
 * releases built before it) until the index job rebuilds them.
 *
 * Segments are immutable. A Stage writes a small segment for the documents
 * that changed; an unchanged file keeps its name, so an upload or a Publish
 * live copy skips it.
 *
 * Shard layout: entry count, restart table (entry offset and posting offset
 * of every 16th entry), the front-coded dictionary (shared prefix length,
 * suffix, document frequency, slot mask, posting length per entry), then
 * the postings. A lookup binary-searches the restart table and scans at
 * most 16 entries on the bytes as loaded, so a cached shard costs its file
 * size in memory. A posting is the key delta, the slot mask and one term
 * frequency per slot in the mask; keyword terms carry mask 0.
 */

import { deflateRawSync, inflateRawSync } from "node:zlib";
import { ByteReader, ByteWriter } from "./bytes.js";
import type { KeyedDoc } from "./schema.js";

/** Entries between two restart points of a shard dictionary. */
export const RESTART_INTERVAL = 16;

/** One term shard of a segment. */
export interface ShardRef {
  readonly file: string;
  readonly first: string;
  readonly last: string;
  readonly bytes: number;
}

/** One store file and the key range it holds. */
export interface StoreRef {
  readonly file: string;
  readonly firstKey: number;
  readonly lastKey: number;
}

/** Vector files of a segment. */
export interface VectorRef {
  readonly field: string;
  readonly dims: number;
  readonly count: number;
  /** Binary codes, `codeRecordBytes(dims)` per passage, at most `VECTORS_PER_CODE_FILE` per file (empty when partitioned). */
  readonly codes: readonly string[];
  /** int8 vectors plus a float32 scale, `VECTORS_PER_BLOCK` per file, in code order (empty when partitioned). */
  readonly blocks: readonly string[];
  /** The partitions of a large segment (#1783), instead of codes and blocks. */
  readonly partitions?: PartitionsRef | null;
}

/** A partitioned segment's vectors: its centroids and one list file per centroid. */
export interface PartitionsRef {
  readonly centroids: string;
  readonly lists: readonly { readonly file: string; readonly count: number }[];
}

/** A packed segment (#1781): one file holding all others, each by name with its offset and length. */
export interface PackRef {
  readonly file: string;
  readonly parts: Readonly<Record<string, readonly [number, number]>>;
}

/** The manifest of one segment. */
export interface SegmentManifest {
  readonly format: 2 | 3;
  readonly slots: readonly string[];
  /** Slots whose words complete a typed prefix. */
  readonly prefixSlots: readonly string[];
  readonly numbers: readonly string[];
  readonly facets: readonly string[];
  readonly docCount: number;
  readonly termCount: number;
  readonly firstKey: number;
  readonly lastKey: number;
  readonly slotLengthSums: readonly number[];
  readonly docsFile: string;
  readonly shards: readonly ShardRef[];
  readonly stores: readonly StoreRef[];
  readonly vectors: VectorRef | null;
  /** Vocabulary file per first-character bucket (see vocabulary.ts). */
  readonly vocabulary: Readonly<Record<string, string>>;
  /** Keyword fields stored per document in the docs file (format 3). */
  readonly columns?: readonly string[];
  /** Set when the segment is one packed file (format 3). */
  readonly pack?: PackRef | null;
}

/** The segment format this engine writes. */
export const SEGMENT_FORMAT = 3;

/** Uncompressed bytes of documents per store block (format 3). */
export const STORE_BLOCK_BYTES = 64 * 1024;

/** Vectors per binary code file. */
export const VECTORS_PER_CODE_FILE = 65_536;

/** Vectors per int8 block file. */
export const VECTORS_PER_BLOCK = 1024;

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder();

/**
 * Orders terms by code point, which is the byte order of their UTF-8 form:
 * the order shard dictionaries are written and searched in. Plain `<` on JS
 * strings compares UTF-16 code units and would put U+10000 and above
 * between U+D7FF and U+E000.
 */
export function compareTerms(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    let x = a.charCodeAt(i);
    let y = b.charCodeAt(i);
    if (x === y) continue;
    if (x >= 0xd800 && x <= 0xdfff) x += 0x2000;
    else if (x >= 0xe000) x -= 0x800;
    if (y >= 0xd800 && y <= 0xdfff) y += 0x2000;
    else if (y >= 0xe000) y -= 0x800;
    return x - y;
  }
  return a.length - b.length;
}

/** Compares `a[aStart, aStart + aLen)` with all of `b`, bytewise. */
export function compareBytes(a: Uint8Array, aStart: number, aLen: number, b: Uint8Array): number {
  const n = Math.min(aLen, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[aStart + i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return aLen - b.length;
}

/** A decoded posting list: ascending keys and term frequencies, dense per slot. */
export interface PostingList {
  readonly keys: Uint32Array;
  readonly tf: Uint16Array;
}

/** Decodes one term's postings into dense per-slot frequencies. */
export function decodePostings(blob: Uint8Array, df: number, slotCount: number): PostingList {
  const r = new ByteReader(blob);
  const keys = new Uint32Array(df);
  const tf = new Uint16Array(df * slotCount);
  let key = 0;
  for (let i = 0; i < df; i++) {
    key += r.uint();
    keys[i] = key;
    const mask = r.uint();
    if (mask === 0) continue;
    for (let f = 0; f < slotCount; f++)
      if (mask & (1 << f)) tf[i * slotCount + f] = Math.min(r.uint(), 0xffff);
  }
  return { keys, tf };
}

/** A term shard as loaded: the raw bytes plus its restart table. */
export interface ParsedShard {
  readonly count: number;
  readonly entryOffsets: Uint32Array;
  readonly postingOffsets: Uint32Array;
  readonly dictStart: number;
  readonly postingsStart: number;
  readonly data: Uint8Array;
}

/** Reads a shard's header; the dictionary stays encoded. */
export function parseShard(data: Uint8Array): ParsedShard {
  const r = new ByteReader(data);
  const count = r.uint();
  const restarts = r.uint();
  const entryOffsets = new Uint32Array(restarts);
  const postingOffsets = new Uint32Array(restarts);
  for (let i = 0; i < restarts; i++) entryOffsets[i] = r.uint();
  for (let i = 0; i < restarts; i++) postingOffsets[i] = r.uint();
  const dictLength = r.uint();
  const dictStart = r.pos;
  return {
    count,
    entryOffsets,
    postingOffsets,
    dictStart,
    postingsStart: dictStart + dictLength,
    data,
  };
}

/** One dictionary entry found in a shard. */
export interface ShardEntry {
  readonly df: number;
  readonly slotMask: number;
  readonly postings: Uint8Array;
}

function restartFor(shard: ParsedShard, target: Uint8Array): number {
  const r = new ByteReader(shard.data);
  let lo = 0;
  let hi = shard.entryOffsets.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    r.pos = shard.dictStart + (shard.entryOffsets[mid] as number);
    r.uint();
    const len = r.uint();
    if (compareBytes(shard.data, r.pos, len, target) <= 0) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

type Visit = (
  term: Uint8Array,
  length: number,
  df: number,
  slotMask: number,
  postings: Uint8Array,
) => boolean;

/** Walks the dictionary from the restart at or before `from` until `visit` returns false. */
function scan(shard: ParsedShard, from: Uint8Array, visit: Visit): void {
  if (shard.entryOffsets.length === 0) return;
  const restart = Math.max(restartFor(shard, from), 0);
  const r = new ByteReader(shard.data, shard.dictStart + (shard.entryOffsets[restart] as number));
  let postingAt = shard.postingsStart + (shard.postingOffsets[restart] as number);
  let term = new Uint8Array(64);
  for (let i = restart * RESTART_INTERVAL; i < shard.count; i++) {
    const shared = r.uint();
    const suffixLen = r.uint();
    if (shared + suffixLen > term.length) {
      const next = new Uint8Array((shared + suffixLen) * 2);
      next.set(term.subarray(0, shared));
      term = next;
    }
    term.set(r.bytes(suffixLen), shared);
    const df = r.uint();
    const slotMask = r.uint();
    const len = r.uint();
    const postings = shard.data.subarray(postingAt, postingAt + len);
    postingAt += len;
    if (!visit(term, shared + suffixLen, df, slotMask, postings)) return;
  }
}

/** Looks up one term in a shard. */
export function findInShard(shard: ParsedShard, term: string): ShardEntry | null {
  const target = utf8.encode(term);
  let result: ShardEntry | null = null;
  scan(shard, target, (bytes, length, df, slotMask, postings) => {
    const c = compareBytes(bytes, 0, length, target);
    if (c === 0) result = { df, slotMask, postings };
    return c < 0;
  });
  return result;
}

/** A dictionary term with its document frequency and the slots it occurs in. */
export interface TermInfo {
  readonly term: string;
  readonly df: number;
  readonly slotMask: number;
}

/** Every term of a shard that starts with `prefix`. */
export function prefixInShard(shard: ParsedShard, prefix: string): TermInfo[] {
  const target = utf8.encode(prefix);
  const out: TermInfo[] = [];
  scan(shard, target, (bytes, length, df, slotMask) => {
    let starts = length >= target.length;
    for (let i = 0; starts && i < target.length; i++) if (bytes[i] !== target[i]) starts = false;
    if (starts) {
      out.push({ term: utf8Decoder.decode(bytes.subarray(0, length)), df, slotMask });
      return true;
    }
    return compareBytes(bytes, 0, length, target) < 0;
  });
  return out;
}

/** Parsed docs file. Every array is positional by document index. */
export interface ParsedDocs {
  /** Ascending: {@link docPosition} binary-searches them. */
  readonly keys: Uint32Array;
  readonly lengths: Uint32Array;
  readonly langs: readonly string[];
  readonly langOrdinals: Uint16Array;
  readonly numbers: ReadonlyMap<string, Float64Array>;
  readonly facets: ReadonlyMap<string, FacetColumn>;
  /** Keyword columns (format 3), in the facet layout. */
  readonly columns: ReadonlyMap<string, FacetColumn>;
}

/** The position of `key` in a docs file, or -1. */
export function docPosition(docs: ParsedDocs, key: number): number {
  const keys = docs.keys;
  let lo = 0;
  let hi = keys.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const k = keys[mid] as number;
    if (k === key) return mid;
    if (k < key) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/** The values of one document in a facet-layout column. */
export function columnValues(column: FacetColumn, position: number): string[] {
  const out: string[] = [];
  for (let j = column.starts[position] as number; j < (column.starts[position + 1] as number); j++)
    out.push(column.values[column.ordinals[j] as number] as string);
  return out;
}

/** The values of one facet field: a value table and, per document, a range of ordinals into it. */
export interface FacetColumn {
  readonly values: readonly string[];
  readonly starts: Uint32Array;
  readonly ordinals: Uint32Array;
}

/** Parses a docs file of a segment. */
export function parseDocs(data: Uint8Array, manifest: SegmentManifest): ParsedDocs {
  const r = new ByteReader(data);
  const n = r.uint();
  const keys = new Uint32Array(n);
  let key = 0;
  for (let i = 0; i < n; i++) {
    key += r.uint();
    keys[i] = key;
  }
  const slotCount = manifest.slots.length;
  const lengths = new Uint32Array(n * slotCount);
  for (let i = 0; i < n * slotCount; i++) lengths[i] = r.uint();
  const langs = Array.from({ length: r.uint() }, () => r.string());
  const langOrdinals = new Uint16Array(n);
  for (let i = 0; i < n; i++) langOrdinals[i] = r.uint();
  const numbers = new Map<string, Float64Array>();
  for (const field of manifest.numbers) {
    const raw = r.bytes(n * 8);
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const column = new Float64Array(n);
    for (let i = 0; i < n; i++) column[i] = view.getFloat64(i * 8, true);
    numbers.set(field, column);
  }
  const readColumn = (): FacetColumn => {
    const values = Array.from({ length: r.uint() }, () => r.string());
    const starts = new Uint32Array(n + 1);
    const ords: number[] = [];
    for (let i = 0; i < n; i++) {
      starts[i] = ords.length;
      const c = r.uint();
      for (let j = 0; j < c; j++) ords.push(r.uint());
    }
    starts[n] = ords.length;
    return { values, starts, ordinals: Uint32Array.from(ords) };
  };
  const facets = new Map<string, FacetColumn>();
  for (const field of manifest.facets) facets.set(field, readColumn());
  const columns = new Map<string, FacetColumn>();
  for (const field of manifest.columns ?? []) columns.set(field, readColumn());
  return { keys, lengths, langs, langOrdinals, numbers, facets, columns };
}

/** Bytes a string costs in memory, about: two per UTF-16 unit plus the object. */
export function stringBytes(s: string): number {
  return 32 + s.length * 2;
}

function columnBytes(c: FacetColumn): number {
  let n = c.starts.byteLength + c.ordinals.byteLength;
  for (const v of c.values) n += stringBytes(v);
  return n;
}

/** Bytes a parsed docs file holds. */
export function docsBytes(d: ParsedDocs): number {
  let n = d.keys.byteLength + d.lengths.byteLength + d.langOrdinals.byteLength + 256;
  for (const l of d.langs) n += stringBytes(l);
  for (const c of d.numbers.values()) n += c.byteLength;
  for (const c of d.facets.values()) n += columnBytes(c);
  for (const c of d.columns.values()) n += columnBytes(c);
  return n;
}

/** Bytes a parsed shard holds: its bytes as loaded and its restart table. */
export function shardBytes(s: ParsedShard): number {
  return s.data.byteLength + s.entryOffsets.byteLength + s.postingOffsets.byteLength + 64;
}

/** Parses a format-2 store file: the documents it holds, in key order. */
export function parseStore(data: Uint8Array): KeyedDoc[] {
  return JSON.parse(utf8Decoder.decode(inflateRawSync(data))) as KeyedDoc[];
}

/** A format-3 store block as loaded: the compressed documents and where each is. */
export interface StoreBlock {
  readonly keys: Uint32Array;
  readonly offsets: Uint32Array;
  readonly lengths: Uint32Array;
  readonly compressed: Uint8Array;
}

/** One document of a store block: its key and its JSON as UTF-8. */
export interface StoreEntry {
  readonly key: number;
  readonly json: Uint8Array;
}

/** Encodes documents (ascending keys, each already JSON) as one format-3 store block. */
export function encodeStoreBlock(entries: readonly StoreEntry[]): Uint8Array {
  const w = new ByteWriter(entries.length * 8 + 16);
  w.uint(entries.length);
  let prev = 0;
  let offset = 0;
  for (const e of entries) {
    w.uint(e.key - prev);
    prev = e.key;
    w.uint(offset);
    w.uint(e.json.length);
    offset += e.json.length;
  }
  const joined = new Uint8Array(offset);
  let at = 0;
  for (const e of entries) {
    joined.set(e.json, at);
    at += e.json.length;
  }
  w.bytes(deflateRawSync(joined, { level: 6 }));
  return w.finish();
}

/** Reads a format-3 store block's table; the documents stay compressed. */
export function parseStoreBlock(data: Uint8Array): StoreBlock {
  const r = new ByteReader(data);
  const n = r.uint();
  const keys = new Uint32Array(n);
  const offsets = new Uint32Array(n);
  const lengths = new Uint32Array(n);
  let key = 0;
  for (let i = 0; i < n; i++) {
    key += r.uint();
    keys[i] = key;
    offsets[i] = r.uint();
    lengths[i] = r.uint();
  }
  return { keys, offsets, lengths, compressed: data.subarray(r.pos) };
}

/** Bytes a store block holds as cached. */
export function storeBlockBytes(b: StoreBlock): number {
  return b.compressed.byteLength + b.keys.byteLength * 3 + 64;
}

/** The documents of a block whose keys `wanted` accepts (all without it), decoded. */
export function storeBlockDocs(b: StoreBlock, wanted?: (key: number) => boolean): KeyedDoc[] {
  const picked: number[] = [];
  for (let i = 0; i < b.keys.length; i++)
    if (!wanted || wanted(b.keys[i] as number)) picked.push(i);
  if (picked.length === 0) return [];
  const text = inflateRawSync(b.compressed);
  return picked.map(
    (i) =>
      JSON.parse(
        utf8Decoder.decode(
          text.subarray(
            b.offsets[i] as number,
            (b.offsets[i] as number) + (b.lengths[i] as number),
          ),
        ),
      ) as KeyedDoc,
  );
}

/** Bytes of one binary code record: key (u32 LE), passage index (u16 LE), then the code. */
export function codeRecordBytes(dims: number): number {
  return 6 + dims / 8;
}
