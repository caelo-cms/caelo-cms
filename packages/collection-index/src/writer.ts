// SPDX-License-Identifier: MPL-2.0

/**
 * Writes one segment from keyed documents in ascending key order (epic
 * #1644, R2), in bounded memory.
 *
 * Documents are analysed in chunks. Each chunk's postings are encoded into
 * a compact run (sorted terms, one byte blob), and the chunk's maps are
 * dropped. `finish` merges the runs: because keys ascend across chunks, the
 * postings of one term are the runs' blobs concatenated, with only the first
 * key of each later blob re-encoded as a delta. Heap use is one chunk plus
 * the encoded runs, close to the final index size, instead of a JS object
 * per posting for the whole collection (2.2 GB at 50,000 pages, #1652).
 *
 * The merge makes two passes over the runs. The first collects the
 * vocabulary (exact words on at least `vocabularyMinDf` documents), which
 * becomes the segment's vocabulary files (typo correction, query-side
 * compound splitting). The second writes the shards and splits each German
 * word against that vocabulary; a compound's postings are also added to its
 * parts' compound terms (`\u007f` prefix, after every ASCII term, so the
 * merge emits them in order once the last ASCII term has passed).
 */

import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { type AnalyzerOptions, analyze, STEM_PREFIX } from "./analyze.js";
import { ByteReader, ByteWriter } from "./bytes.js";
import { splitCompound } from "./compound.js";
import {
  type CollectionSchema,
  idTerm,
  type KeyedDoc,
  keywordTerm,
  keywordValues,
  langTerm,
  layoutOf,
  numberValue,
  type SchemaLayout,
  slotText,
} from "./schema.js";
import {
  codeRecordBytes,
  compareBytes,
  RESTART_INTERVAL,
  type SegmentManifest,
  type ShardRef,
  type StoreRef,
  VECTORS_PER_BLOCK,
  VECTORS_PER_CODE_FILE,
  type VectorRef,
} from "./segment.js";
import { type EncodedVector, encodeVector } from "./vectors.js";
import { encodeVocabulary, vocabularyBucket } from "./vocabulary.js";

/** Dictionary prefix of compound-part terms. Sorts after every ASCII term. */
export const COMPOUND_PREFIX = "\u007f";

/** Where finished files go: object storage, a directory, a map in tests. */
export type FileSink = (name: string, data: Uint8Array) => void;

/** Writer options. */
export interface WriterOptions extends AnalyzerOptions {
  readonly schema: CollectionSchema;
  readonly sink: FileSink;
  /** Target bytes per term shard; one large posting list may exceed it. */
  readonly shardBytes?: number;
  /** Documents per store file. */
  readonly docsPerStore?: number;
  /** Documents analysed before a chunk is encoded into a run. */
  readonly chunkDocs?: number;
  /** Words outside this segment that count as vocabulary, with their document frequency (a delta's base). */
  readonly vocabulary?: ReadonlyMap<string, number>;
  /** Least document frequency for a word of this segment to join its vocabulary. */
  readonly vocabularyMinDf?: number;
  /** Vector dimensions; without them the vector field carries no vectors (semantic search off). */
  readonly dims?: number;
}

/** What `finish` returns besides the files already handed to the sink. */
export interface WrittenSegment {
  readonly manifest: SegmentManifest;
  /** The manifest's own file name (content-addressed), already handed to the sink. */
  readonly manifestFile: string;
  /** Vocabulary file per bucket, already handed to the sink. */
  readonly vocabulary: Readonly<Record<string, string>>;
  readonly bytesWritten: number;
}

interface ChunkPosting {
  keys: number[];
  masks: number[];
  tfs: number[];
  slotMask: number;
  german: boolean;
}

/** Content-addressed file name: kind letter, 24 hex digits of SHA-256, extension. */
export function contentName(kind: string, data: Uint8Array, ext: string): string {
  return `${kind}-${createHash("sha256").update(data).digest("hex").slice(0, 24)}.${ext}`;
}

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder();

/** Writes one segment. Call `add` per document in ascending key order, then `finish`. */
export class SegmentWriter {
  private readonly layout: SchemaLayout;
  private readonly runs: Uint8Array[] = [];
  private chunk = new Map<string, ChunkPosting>();
  private chunkCount = 0;
  private lastKey = -1;
  private firstKey = -1;
  private bytes = 0;
  private readonly keys: number[] = [];
  private readonly lengths: number[] = [];
  private readonly slotSums: number[];
  private readonly langOrdinal = new Map<string, number>();
  private readonly langs: number[] = [];
  private readonly numbers: number[][];
  private readonly facetValues: string[][][];
  private storeBatch: KeyedDoc[] = [];
  private readonly stores: StoreRef[] = [];
  private readonly codeFiles: string[] = [];
  private readonly blockFiles: string[] = [];
  private codeBuf: ByteWriter | null = null;
  private codeCount = 0;
  private blockBuf: ByteWriter | null = null;
  private blockCount = 0;
  private vectorCount = 0;

  constructor(private readonly o: WriterOptions) {
    this.layout = layoutOf(o.schema);
    this.slotSums = new Array<number>(this.layout.slots.length).fill(0);
    this.numbers = this.layout.numbers.map(() => []);
    this.facetValues = this.layout.facets.map(() => []);
    if (o.dims !== undefined && (o.dims <= 0 || o.dims % 8 !== 0))
      throw new RangeError("SegmentWriter: `dims` must be a positive multiple of 8");
  }

  private emit(name: string, data: Uint8Array): string {
    this.o.sink(name, data);
    this.bytes += data.length;
    return name;
  }

  /**
   * Adds one document. `vectors` holds one embedding per passage of the
   * schema's vector field, in passage order: a float vector from the model,
   * or an already encoded one carried over by a merge. A missing entry has
   * no vector.
   */
  add(doc: KeyedDoc, vectors?: readonly (Float32Array | EncodedVector | null | undefined)[]): void {
    if (!Number.isInteger(doc.key) || doc.key < 1)
      throw new RangeError(`SegmentWriter: key ${doc.key} must be a positive integer`);
    if (doc.key <= this.lastKey)
      throw new RangeError(`SegmentWriter: key ${doc.key} is not above ${this.lastKey}`);
    if (this.firstKey < 0) this.firstKey = doc.key;
    this.lastKey = doc.key;
    this.keys.push(doc.key);
    const lang = doc.lang.toLowerCase();
    const german = lang.split("-")[0] === "de";
    let ord = this.langOrdinal.get(lang);
    if (ord === undefined) {
      ord = this.langOrdinal.size;
      this.langOrdinal.set(lang, ord);
    }
    this.langs.push(ord);

    const nSlots = this.layout.slots.length;
    const perTerm = new Map<string, number[]>();
    this.layout.slots.forEach((slot, s) => {
      const tokens = analyze(slotText(doc, slot), lang, this.o);
      this.lengths.push(tokens.length);
      this.slotSums[s] = (this.slotSums[s] as number) + tokens.length;
      for (const t of tokens) {
        const terms = t.stem && t.stem !== t.exact ? [t.exact, STEM_PREFIX + t.stem] : [t.exact];
        for (const term of terms) {
          let tf = perTerm.get(term);
          if (!tf) {
            tf = new Array<number>(nSlots).fill(0);
            perTerm.set(term, tf);
          }
          tf[s] = (tf[s] as number) + 1;
        }
      }
    });
    for (const [term, tf] of perTerm) {
      let mask = 0;
      const p = this.posting(term, german);
      tf.forEach((n, s) => {
        if (n > 0) {
          mask |= 1 << s;
          p.tfs.push(n);
        }
      });
      p.keys.push(doc.key);
      p.masks.push(mask);
      p.slotMask |= mask;
    }
    const keywordTerms = new Set<string>([idTerm(doc.id), langTerm(lang)]);
    for (const field of this.layout.keywords)
      for (const v of keywordValues(doc, field)) keywordTerms.add(keywordTerm(field, v));
    for (const term of keywordTerms) {
      const p = this.posting(term, false);
      p.keys.push(doc.key);
      p.masks.push(0);
    }
    this.layout.numbers.forEach((field, i) => {
      this.numbers[i]?.push(numberValue(doc, field));
    });
    this.layout.facets.forEach((field, i) => {
      this.facetValues[i]?.push(keywordValues(doc, field));
    });

    this.storeBatch.push({ id: doc.id, key: doc.key, lang, values: doc.values });
    if (this.storeBatch.length >= (this.o.docsPerStore ?? 32)) this.flushStore();

    const vectorField = this.layout.vectorFields[0];
    if (vectorField && vectors) {
      vectors.forEach((v, passage) => {
        if (v) this.addVector(doc.key, passage, v);
      });
    }

    this.chunkCount++;
    if (this.chunkCount >= (this.o.chunkDocs ?? 2000)) this.flushChunk();
  }

  private posting(term: string, german: boolean): ChunkPosting {
    let p = this.chunk.get(term);
    if (!p) {
      p = { keys: [], masks: [], tfs: [], slotMask: 0, german };
      this.chunk.set(term, p);
    } else if (german) p.german = true;
    return p;
  }

  private addVector(key: number, passage: number, v: Float32Array | EncodedVector): void {
    if (this.o.dims === undefined)
      throw new RangeError(
        "SegmentWriter: vectors given, but the writer has no `dims` (no vector model)",
      );
    const dims = this.o.dims;
    const length = v instanceof Float32Array ? v.length : v.int8.length;
    if (length !== dims)
      throw new RangeError(`SegmentWriter: vector of ${length} dimensions, expected ${dims}`);
    if (passage > 0xffff)
      throw new RangeError("SegmentWriter: at most 65,536 passages per document carry vectors");
    const { code, int8, scale } = v instanceof Float32Array ? encodeVector(v) : v;
    this.codeBuf ??= new ByteWriter(Math.min(VECTORS_PER_CODE_FILE, 4096) * codeRecordBytes(dims));
    const rec = new Uint8Array(6);
    new DataView(rec.buffer).setUint32(0, key, true);
    new DataView(rec.buffer).setUint16(4, passage, true);
    this.codeBuf.bytes(rec);
    this.codeBuf.bytes(code);
    this.blockBuf ??= new ByteWriter(VECTORS_PER_BLOCK * (dims + 4));
    const s = new Uint8Array(4);
    new DataView(s.buffer).setFloat32(0, scale, true);
    this.blockBuf.bytes(s);
    this.blockBuf.bytes(new Uint8Array(int8.buffer, int8.byteOffset, int8.length));
    this.vectorCount++;
    if (++this.codeCount >= VECTORS_PER_CODE_FILE) this.flushCodes();
    if (++this.blockCount >= VECTORS_PER_BLOCK) this.flushBlock();
  }

  private flushCodes(): void {
    if (!this.codeBuf || this.codeCount === 0) return;
    const data = this.codeBuf.finish();
    this.codeFiles.push(this.emit(contentName("c", data, "bin"), data));
    this.codeBuf = null;
    this.codeCount = 0;
  }

  private flushBlock(): void {
    if (!this.blockBuf || this.blockCount === 0) return;
    const data = this.blockBuf.finish();
    this.blockFiles.push(this.emit(contentName("q", data, "bin"), data));
    this.blockBuf = null;
    this.blockCount = 0;
  }

  private flushStore(): void {
    if (this.storeBatch.length === 0) return;
    const data = deflateRawSync(utf8.encode(JSON.stringify(this.storeBatch)), { level: 6 });
    const file = this.emit(contentName("s", data, "bin"), data);
    this.stores.push({
      file,
      firstKey: (this.storeBatch[0] as KeyedDoc).key,
      lastKey: (this.storeBatch[this.storeBatch.length - 1] as KeyedDoc).key,
    });
    this.storeBatch = [];
  }

  /** Encodes the chunk into a run: per term in byte order, its bytes, df, last key, slot mask, German flag and postings. */
  private flushChunk(): void {
    if (this.chunk.size === 0) return;
    const nSlots = this.layout.slots.length;
    const entries = [...this.chunk.entries()].map(([term, p]) => ({ bytes: utf8.encode(term), p }));
    entries.sort((a, b) => compareBytes(a.bytes, 0, a.bytes.length, b.bytes));
    const w = new ByteWriter(1 << 20);
    w.uint(entries.length);
    for (const { bytes, p } of entries) {
      w.uint(bytes.length);
      w.bytes(bytes);
      w.uint(p.keys.length);
      w.uint(p.keys[p.keys.length - 1] as number);
      w.uint(p.slotMask);
      w.uint(p.german ? 1 : 0);
      const blob = new ByteWriter(p.keys.length * 3 + 8);
      let prev = 0;
      let tfAt = 0;
      for (let i = 0; i < p.keys.length; i++) {
        const key = p.keys[i] as number;
        blob.uint(key - prev);
        prev = key;
        const mask = p.masks[i] as number;
        blob.uint(mask);
        for (let s = 0; s < nSlots; s++) if (mask & (1 << s)) blob.uint(p.tfs[tfAt++] as number);
      }
      const b = blob.finish();
      w.uint(b.length);
      w.bytes(b);
    }
    this.runs.push(w.finish());
    this.chunk = new Map();
    this.chunkCount = 0;
  }

  /** Writes the remaining files and the manifest. The writer cannot be used afterwards. */
  finish(): WrittenSegment {
    this.flushChunk();
    this.flushStore();
    this.flushCodes();
    this.flushBlock();
    const nSlots = this.layout.slots.length;

    // Pass 1: the vocabulary.
    const minDf = this.o.vocabularyMinDf ?? (this.keys.length >= 1000 ? 2 : 1);
    const vocabulary = new Map<string, number>();
    mergeRuns(this.runs, (term, df) => {
      if (term.startsWith(STEM_PREFIX) || term.charCodeAt(0) < 0x20) return;
      if (df >= minDf && term.length >= 3 && !/\d/.test(term)) vocabulary.set(term, df);
    });
    const known = (w: string): number =>
      (vocabulary.get(w) ?? 0) + (this.o.vocabulary?.get(w) ?? 0);

    // Pass 2: shards, with compound-part postings appended at their place.
    const shards = new ShardWriter(this.o.shardBytes ?? 64 * 1024, nSlots, (name, data) =>
      this.emit(name, data),
    );
    const parts = new Map<string, Uint8Array[]>();
    let partsEmitted = false;
    const emitParts = (): void => {
      if (partsEmitted) return;
      partsEmitted = true;
      for (const part of [...parts.keys()].sort()) {
        const united = uniteEncoded(parts.get(part) as Uint8Array[], nSlots);
        shards.add(utf8.encode(COMPOUND_PREFIX + part), united.df, united.slotMask, united.blob);
      }
    };
    // Compounds are folded ASCII words, so every one of them streams past
    // before the first term above 0x7f, where their parts' terms belong.
    mergeRuns(this.runs, (term, df, mask, german, blob, bytes) => {
      if (!partsEmitted && (bytes[0] as number) >= 0x7f) emitParts();
      shards.add(bytes, df, mask, blob);
      const split = german ? splitCompound(term, known) : null;
      if (split)
        for (const part of new Set(split))
          (parts.get(part) ?? parts.set(part, []).get(part))?.push(blob);
    });
    emitParts();
    this.runs.length = 0;
    const shardRefs = shards.finish();

    const docsFile = this.writeDocs();
    const vocabFiles: Record<string, string> = {};
    const buckets = new Map<string, [string, number][]>();
    for (const [word, df] of vocabulary) {
      const b = vocabularyBucket(word);
      (buckets.get(b) ?? buckets.set(b, []).get(b))?.push([word, df]);
    }
    for (const [bucket, words] of [...buckets.entries()].sort()) {
      const data = encodeVocabulary(words);
      vocabFiles[bucket] = this.emit(contentName("w", data, "bin"), data);
    }

    const vectorField = this.layout.vectorFields[0];
    const vectors: VectorRef | null =
      vectorField && this.vectorCount > 0
        ? {
            field: vectorField,
            dims: this.o.dims as number,
            count: this.vectorCount,
            codes: this.codeFiles,
            blocks: this.blockFiles,
          }
        : null;
    const manifest: SegmentManifest = {
      format: 2,
      slots: this.layout.slots.map((s) => s.name),
      prefixSlots: this.layout.slots.filter((s) => s.prefix).map((s) => s.name),
      numbers: [...this.layout.numbers],
      facets: [...this.layout.facets],
      docCount: this.keys.length,
      termCount: shards.termCount,
      firstKey: Math.max(this.firstKey, 0),
      lastKey: Math.max(this.lastKey, 0),
      slotLengthSums: this.slotSums,
      docsFile,
      shards: shardRefs,
      stores: this.stores,
      vectors,
      vocabulary: vocabFiles,
    };
    const manifestData = utf8.encode(JSON.stringify(manifest));
    const manifestFile = this.emit(contentName("m", manifestData, "json"), manifestData);
    return { manifest, manifestFile, vocabulary: vocabFiles, bytesWritten: this.bytes };
  }

  private writeDocs(): string {
    const n = this.keys.length;
    const w = new ByteWriter(n * (4 + this.layout.slots.length * 2) + 1024);
    w.uint(n);
    let prev = 0;
    for (const key of this.keys) {
      w.uint(key - prev);
      prev = key;
    }
    for (const len of this.lengths) w.uint(len);
    const langs = [...this.langOrdinal.entries()].sort((a, b) => a[1] - b[1]).map(([l]) => l);
    w.uint(langs.length);
    for (const l of langs) w.string(l);
    for (const o of this.langs) w.uint(o);
    for (const column of this.numbers) {
      const buf = new Uint8Array(n * 8);
      const view = new DataView(buf.buffer);
      column.forEach((v, i) => {
        view.setFloat64(i * 8, v, true);
      });
      w.bytes(buf);
    }
    for (const column of this.facetValues) {
      const table = [...new Set(column.flat())].sort();
      const ordinal = new Map(table.map((v, i) => [v, i] as const));
      w.uint(table.length);
      for (const v of table) w.string(v);
      for (const values of column) {
        w.uint(values.length);
        for (const v of values) w.uint(ordinal.get(v) as number);
      }
    }
    const data = w.finish();
    return this.emit(contentName("d", data, "bin"), data);
  }
}

/** Reads a run entry by entry. */
class RunCursor {
  private readonly r: ByteReader;
  private remaining: number;
  bytes: Uint8Array = new Uint8Array(0);
  df = 0;
  lastKey = 0;
  mask = 0;
  german = false;
  blob: Uint8Array = new Uint8Array(0);
  done = false;

  constructor(run: Uint8Array) {
    this.r = new ByteReader(run);
    this.remaining = this.r.uint();
    this.next();
  }

  next(): void {
    if (this.remaining === 0) {
      this.done = true;
      return;
    }
    this.remaining--;
    this.bytes = this.r.bytes(this.r.uint());
    this.df = this.r.uint();
    this.lastKey = this.r.uint();
    this.mask = this.r.uint();
    this.german = this.r.uint() === 1;
    this.blob = this.r.bytes(this.r.uint());
  }
}

/**
 * Merges runs in term order. For each term, calls `visit` with the term,
 * its total df, slot mask, German flag, the concatenated postings and the
 * term's bytes.
 */
function mergeRuns(
  runs: readonly Uint8Array[],
  visit: (
    term: string,
    df: number,
    mask: number,
    german: boolean,
    blob: Uint8Array,
    bytes: Uint8Array,
  ) => void,
): void {
  const cursors = runs.map((r) => new RunCursor(r)).filter((c) => !c.done);
  while (cursors.length > 0) {
    let min = cursors[0] as RunCursor;
    for (const c of cursors) if (compareBytes(c.bytes, 0, c.bytes.length, min.bytes) < 0) min = c;
    const bytes = min.bytes;
    let df = 0;
    let mask = 0;
    let german = false;
    let prevLast = -1;
    const parts: Uint8Array[] = [];
    for (const c of cursors) {
      if (c.done || compareBytes(c.bytes, 0, c.bytes.length, bytes) !== 0) continue;
      df += c.df;
      mask |= c.mask;
      german ||= c.german;
      parts.push(prevLast < 0 ? c.blob : rebaseFirstKey(c.blob, prevLast));
      prevLast = c.lastKey;
    }
    const blob = parts.length === 1 ? (parts[0] as Uint8Array) : concat(parts);
    const termBytes = new Uint8Array(bytes);
    visit(utf8Decoder.decode(termBytes), df, mask, german, blob, termBytes);
    for (const c of cursors)
      if (!c.done && compareBytes(c.bytes, 0, c.bytes.length, termBytes) === 0) c.next();
    for (let i = cursors.length - 1; i >= 0; i--)
      if ((cursors[i] as RunCursor).done) cursors.splice(i, 1);
  }
}

/** A posting blob starts with an absolute key; after `prevLast` it must start with the delta. */
function rebaseFirstKey(blob: Uint8Array, prevLast: number): Uint8Array {
  const r = new ByteReader(blob);
  const first = r.uint();
  const w = new ByteWriter(blob.length + 4);
  w.uint(first - prevLast);
  w.bytes(blob.subarray(r.pos));
  return w.finish();
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Unites encoded posting blobs (each starting at an absolute key), summing frequencies per key and slot. */
function uniteEncoded(
  blobs: readonly Uint8Array[],
  nSlots: number,
): { df: number; slotMask: number; blob: Uint8Array } {
  const tf = new Map<number, number[]>();
  for (const blob of blobs) {
    const r = new ByteReader(blob);
    let key = 0;
    while (!r.done) {
      key += r.uint();
      const mask = r.uint();
      const row = tf.get(key) ?? tf.set(key, new Array<number>(nSlots).fill(0)).get(key);
      for (let s = 0; s < nSlots; s++)
        if (mask & (1 << s) && row) row[s] = (row[s] as number) + r.uint();
    }
  }
  const keys = [...tf.keys()].sort((a, b) => a - b);
  const w = new ByteWriter(keys.length * 4);
  let prev = 0;
  let slotMask = 0;
  for (const key of keys) {
    const row = tf.get(key) as number[];
    let mask = 0;
    row.forEach((n, s) => {
      if (n > 0) mask |= 1 << s;
    });
    slotMask |= mask;
    w.uint(key - prev);
    prev = key;
    w.uint(mask);
    for (const n of row) if (n > 0) w.uint(n);
  }
  return { df: keys.length, slotMask, blob: w.finish() };
}

/** Collects dictionary entries into shards of about `shardBytes`. */
class ShardWriter {
  private batch: { bytes: Uint8Array; df: number; mask: number; blob: Uint8Array }[] = [];
  private size = 0;
  private readonly refs: ShardRef[] = [];
  termCount = 0;

  constructor(
    private readonly shardBytes: number,
    _nSlots: number,
    private readonly emit: (name: string, data: Uint8Array) => string,
  ) {}

  add(bytes: Uint8Array, df: number, mask: number, blob: Uint8Array): void {
    if (this.size > 0 && this.size + blob.length + bytes.length > this.shardBytes) this.flush();
    this.batch.push({ bytes, df, mask, blob });
    this.size += blob.length + bytes.length + 5;
    this.termCount++;
  }

  private flush(): void {
    if (this.batch.length === 0) return;
    const dict = new ByteWriter(this.batch.length * 12);
    const entryOffsets: number[] = [];
    const postingOffsets: number[] = [];
    let postingAt = 0;
    let prev: Uint8Array = new Uint8Array(0);
    this.batch.forEach((e, i) => {
      let shared = 0;
      if (i % RESTART_INTERVAL === 0) {
        entryOffsets.push(dict.length);
        postingOffsets.push(postingAt);
      } else {
        const max = Math.min(prev.length, e.bytes.length);
        while (shared < max && prev[shared] === e.bytes[shared]) shared++;
      }
      dict.uint(shared);
      dict.uint(e.bytes.length - shared);
      dict.bytes(e.bytes.subarray(shared));
      dict.uint(e.df);
      dict.uint(e.mask);
      dict.uint(e.blob.length);
      postingAt += e.blob.length;
      prev = e.bytes;
    });
    const dictBytes = dict.finish();
    const w = new ByteWriter(dictBytes.length + postingAt + entryOffsets.length * 6 + 16);
    w.uint(this.batch.length);
    w.uint(entryOffsets.length);
    for (const o of entryOffsets) w.uint(o);
    for (const o of postingOffsets) w.uint(o);
    w.uint(dictBytes.length);
    w.bytes(dictBytes);
    for (const e of this.batch) w.bytes(e.blob);
    const data = w.finish();
    const file = this.emit(contentName("t", data, "bin"), data);
    const first = utf8Decoder.decode((this.batch[0] as { bytes: Uint8Array }).bytes);
    const last = utf8Decoder.decode(
      (this.batch[this.batch.length - 1] as { bytes: Uint8Array }).bytes,
    );
    this.refs.push({ file, first, last, bytes: data.length });
    this.batch = [];
    this.size = 0;
  }

  finish(): ShardRef[] {
    this.flush();
    return this.refs;
  }
}

/** Convenience for tests and small builds: writes every document and keeps the files in a map. */
export function buildSegment(
  docs: Iterable<
    KeyedDoc | { doc: KeyedDoc; vectors?: readonly (Float32Array | EncodedVector | null)[] }
  >,
  options: Omit<WriterOptions, "sink">,
): WrittenSegment & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  const writer = new SegmentWriter({ ...options, sink: (name, data) => files.set(name, data) });
  for (const d of docs) {
    if ("doc" in d) writer.add(d.doc, d.vectors);
    else writer.add(d);
  }
  return { ...writer.finish(), files };
}
