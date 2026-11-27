// SPDX-License-Identifier: MPL-2.0

/**
 * Partitioned vectors for large segments (#1783), the inverted-file idea of
 * FAISS's IVF indexes.
 *
 * A flat segment ranks every passage by its binary code and rescores the
 * best 200 with their int8 vectors, which live in blocks of 1,024 in code
 * order. At 500,000 passages that is 27 MB of codes held in memory and,
 * for a cold query, about 160 of 490 int8 blocks (65 MB) read at random,
 * because the 200 candidates are spread over the whole segment.
 *
 * A partitioned segment groups its passages by meaning instead: a seeded,
 * deterministic spherical k-means puts each passage in the list of its
 * nearest centroid, and each list file holds its passages' int8 vectors
 * and codes together. A query scores the centroids (about 1 MB of floats,
 * the only part every query needs), reads the `probe` nearest lists in one
 * parallel round and scores their passages with int8 directly: no binary
 * prefilter, so a passage in a probed list is never lost to the codes'
 * coarseness. A passage in a list that is not probed is the cost; the
 * bench (`bench/partitions.ts`) measures recall against exhaustive int8
 * search, and `docs/dev/scale-gate.md` holds the numbers that set
 * {@link DEFAULT_PROBE}.
 *
 * Training samples every `stride`-th passage and assigns through a binary
 * shortlist (the centroids' sign codes by Hamming distance, then exact dot
 * products with the {@link SHORTLIST} closest): at 500,000 passages an
 * exact assignment would be 94 billion multiply-adds in JavaScript. A
 * passage that the shortlist sends to its second-nearest list is still
 * found by a query that probes both, which a query near it does.
 *
 * Everything here is deterministic: the same vectors give the same lists,
 * so a rebuild reproduces the files and a cached answer agrees with a
 * fresh one.
 */

import { binaryCode, type EncodedVector } from "./vectors.js";

/** A segment with at least this many vectors is partitioned. */
export const PARTITION_MIN_VECTORS = 32_768;
/** Passages per list a partitioned segment aims for. */
export const VECTORS_PER_LIST = 1024;
/** Lists a query probes unless it asks for another number. */
export const DEFAULT_PROBE = 24;
/** Centroids a passage is compared with exactly, after the Hamming shortlist. */
export const SHORTLIST = 8;
/** Lloyd iterations on the sample. */
const ITERATIONS = 12;
/** Sample passages per list for training. */
const SAMPLE_PER_LIST = 40;

/** Vectors kept by a writer until it knows the segment's size: columnar, in chunks (no copy as they grow). */
export class VectorBuffer {
  private static readonly CHUNK = 16_384;
  private readonly chunks: {
    keys: Uint32Array;
    passages: Uint16Array;
    scales: Float32Array;
    int8: Int8Array;
    codes: Uint8Array;
  }[] = [];
  count = 0;

  constructor(readonly dims: number) {}

  push(key: number, passage: number, v: EncodedVector): void {
    const c = VectorBuffer.CHUNK;
    const at = this.count % c;
    if (at === 0)
      this.chunks.push({
        keys: new Uint32Array(c),
        passages: new Uint16Array(c),
        scales: new Float32Array(c),
        int8: new Int8Array(c * this.dims),
        codes: new Uint8Array((c * this.dims) / 8),
      });
    const chunk = this.chunks[this.chunks.length - 1] as (typeof this.chunks)[number];
    chunk.keys[at] = key;
    chunk.passages[at] = passage;
    chunk.scales[at] = v.scale;
    chunk.int8.set(v.int8, at * this.dims);
    chunk.codes.set(v.code, (at * this.dims) / 8);
    this.count++;
  }

  private chunkOf(i: number): [(typeof this.chunks)[number], number] {
    const c = VectorBuffer.CHUNK;
    return [this.chunks[Math.floor(i / c)] as (typeof this.chunks)[number], i % c];
  }

  key(i: number): number {
    const [c, at] = this.chunkOf(i);
    return c.keys[at] as number;
  }

  passage(i: number): number {
    const [c, at] = this.chunkOf(i);
    return c.passages[at] as number;
  }

  /** The stored encoding of vector `i` (views into the buffer). */
  encoded(i: number): EncodedVector {
    const [c, at] = this.chunkOf(i);
    const d = this.dims;
    return {
      scale: c.scales[at] as number,
      int8: c.int8.subarray(at * d, (at + 1) * d),
      code: c.codes.subarray((at * d) / 8, ((at + 1) * d) / 8),
    };
  }

  /** Vector `i` as floats (int8 × scale), into `out`. */
  float(i: number, out: Float32Array): Float32Array {
    const [c, at] = this.chunkOf(i);
    const d = this.dims;
    const scale = c.scales[at] as number;
    for (let j = 0; j < d; j++) out[j] = (c.int8[at * d + j] as number) * scale;
    return out;
  }

  /** Vector `i`'s binary code as 32-bit words, into `out`. */
  words(i: number, out: Uint32Array): Uint32Array {
    const [c, at] = this.chunkOf(i);
    const bytes = this.dims / 8;
    for (let w = 0; w < out.length; w++) {
      let word = 0;
      for (let b = 0; b < 4; b++) word = (word << 8) | (c.codes[at * bytes + w * 4 + b] ?? 0);
      out[w] = word >>> 0;
    }
    return out;
  }
}

function popcount32(x: number): number {
  let v = x - ((x >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function normalizeInPlace(v: Float32Array, at: number, dims: number): void {
  let sum = 0;
  for (let j = 0; j < dims; j++) sum += (v[at + j] as number) ** 2;
  if (sum === 0) return;
  const inv = 1 / Math.sqrt(sum);
  for (let j = 0; j < dims; j++) v[at + j] = (v[at + j] as number) * inv;
}

/** Binary codes of every centroid as 32-bit words. */
function centroidWords(centroids: Float32Array, count: number, dims: number): Uint32Array {
  const perCode = Math.ceil(dims / 32);
  const out = new Uint32Array(count * perCode);
  for (let c = 0; c < count; c++) {
    const code = binaryCode(centroids.subarray(c * dims, (c + 1) * dims));
    for (let w = 0; w < perCode; w++) {
      let word = 0;
      for (let b = 0; b < 4; b++) word = (word << 8) | (code[w * 4 + b] ?? 0);
      out[c * perCode + w] = word >>> 0;
    }
  }
  return out;
}

/**
 * The nearest centroid of `x` (floats) through the shortlist: the
 * {@link SHORTLIST} centroids closest by Hamming distance of the codes, then
 * the largest dot product among them; ties to the lower index.
 */
function nearest(
  x: Float32Array,
  words: Uint32Array,
  centroids: Float32Array,
  cWords: Uint32Array,
  count: number,
  dims: number,
  bestH: Int32Array,
  bestC: Int32Array,
): number {
  const perCode = words.length;
  const t = Math.min(SHORTLIST, count);
  bestH.fill(0x7fffffff, 0, t);
  bestC.fill(-1, 0, t);
  for (let c = 0; c < count; c++) {
    let h = 0;
    for (let w = 0; w < perCode; w++)
      h += popcount32(((words[w] as number) ^ (cWords[c * perCode + w] as number)) >>> 0);
    if (h >= (bestH[t - 1] as number)) continue;
    let i = t - 1;
    while (i > 0 && (bestH[i - 1] as number) > h) {
      bestH[i] = bestH[i - 1] as number;
      bestC[i] = bestC[i - 1] as number;
      i--;
    }
    bestH[i] = h;
    bestC[i] = c;
  }
  let best = -1;
  let bestDot = Number.NEGATIVE_INFINITY;
  for (let k = 0; k < t; k++) {
    const c = bestC[k] as number;
    if (c < 0) continue;
    let dot = 0;
    for (let j = 0; j < dims; j++) dot += (x[j] as number) * (centroids[c * dims + j] as number);
    if (dot > bestDot || (dot === bestDot && c < best)) {
      bestDot = dot;
      best = c;
    }
  }
  return best;
}

/** The number of lists for `count` vectors. */
export function listCount(count: number): number {
  return Math.max(16, Math.min(4096, Math.round(count / VECTORS_PER_LIST)));
}

/** What {@link partition} produced: L2-normalised centroids and each vector's list. */
export interface Partition {
  readonly lists: number;
  readonly centroids: Float32Array;
  readonly assignment: Uint32Array;
}

/** Partitions a buffer's vectors into {@link listCount} lists. Deterministic. */
export function partition(buffer: VectorBuffer): Partition {
  const n = buffer.count;
  const dims = buffer.dims;
  const k = Math.min(listCount(n), n);
  const perCode = Math.ceil(dims / 32);
  const sampleSize = Math.min(n, k * SAMPLE_PER_LIST);
  const sample = new Float32Array(sampleSize * dims);
  const sampleWords = new Uint32Array(sampleSize * perCode);
  const x = new Float32Array(dims);
  const w = new Uint32Array(perCode);
  for (let s = 0; s < sampleSize; s++) {
    const i = Math.floor((s * n) / sampleSize);
    sample.set(buffer.float(i, x), s * dims);
    sampleWords.set(buffer.words(i, w), s * perCode);
  }
  // Start from sample vectors spread evenly through the sample.
  const centroids = new Float32Array(k * dims);
  for (let c = 0; c < k; c++) {
    const s = Math.floor((c * sampleSize) / k);
    centroids.set(sample.subarray(s * dims, (s + 1) * dims), c * dims);
    normalizeInPlace(centroids, c * dims, dims);
  }
  const bestH = new Int32Array(SHORTLIST);
  const bestC = new Int32Array(SHORTLIST);
  const sums = new Float64Array(k * dims);
  const sizes = new Uint32Array(k);
  const own = new Int32Array(sampleSize);
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    const cWords = centroidWords(centroids, k, dims);
    sums.fill(0);
    sizes.fill(0);
    for (let s = 0; s < sampleSize; s++) {
      const xs = sample.subarray(s * dims, (s + 1) * dims);
      const c = nearest(
        xs,
        sampleWords.subarray(s * perCode, (s + 1) * perCode),
        centroids,
        cWords,
        k,
        dims,
        bestH,
        bestC,
      );
      own[s] = c;
      sizes[c] = (sizes[c] as number) + 1;
      for (let j = 0; j < dims; j++)
        sums[c * dims + j] = (sums[c * dims + j] as number) + (xs[j] as number);
    }
    for (let c = 0; c < k; c++) {
      if (sizes[c] === 0) {
        // An empty list takes the sample vector least like its own centroid.
        let worst = -1;
        let worstDot = Number.POSITIVE_INFINITY;
        for (let s = 0; s < sampleSize; s++) {
          const o = own[s] as number;
          if ((sizes[o] as number) <= 1) continue;
          let dot = 0;
          for (let j = 0; j < dims; j++)
            dot += (sample[s * dims + j] as number) * (centroids[o * dims + j] as number);
          if (dot < worstDot) {
            worstDot = dot;
            worst = s;
          }
        }
        if (worst < 0) continue;
        sizes[own[worst] as number] = (sizes[own[worst] as number] as number) - 1;
        own[worst] = c;
        sizes[c] = 1;
        centroids.set(sample.subarray(worst * dims, (worst + 1) * dims), c * dims);
        normalizeInPlace(centroids, c * dims, dims);
        continue;
      }
      for (let j = 0; j < dims; j++)
        centroids[c * dims + j] = (sums[c * dims + j] as number) / (sizes[c] as number);
      normalizeInPlace(centroids, c * dims, dims);
    }
  }
  const cWords = centroidWords(centroids, k, dims);
  const assignment = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    buffer.float(i, x);
    assignment[i] = nearest(x, buffer.words(i, w), centroids, cWords, k, dims, bestH, bestC);
  }
  return { lists: k, centroids, assignment };
}

/** Centroids file: count and dims (u32 LE), then count × dims float32 LE. */
export function encodeCentroids(centroids: Float32Array, count: number, dims: number): Uint8Array {
  const out = new Uint8Array(8 + count * dims * 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, count, true);
  view.setUint32(4, dims, true);
  for (let i = 0; i < count * dims; i++) view.setFloat32(8 + i * 4, centroids[i] as number, true);
  return out;
}

/** Parsed centroids. */
export interface Centroids {
  readonly count: number;
  readonly dims: number;
  readonly values: Float32Array;
}

export function parseCentroids(data: Uint8Array): Centroids {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = view.getUint32(0, true);
  const dims = view.getUint32(4, true);
  const values = new Float32Array(count * dims);
  for (let i = 0; i < count * dims; i++) values[i] = view.getFloat32(8 + i * 4, true);
  return { count, dims, values };
}

/** Bytes of one list record: key (u32), passage (u16), scale (f32), int8 vector, binary code. */
export function listRecordBytes(dims: number): number {
  return 10 + dims + dims / 8;
}

/** Encodes the records `indices` of `buffer` as one list file. */
export function encodeList(buffer: VectorBuffer, indices: readonly number[]): Uint8Array {
  const dims = buffer.dims;
  const record = listRecordBytes(dims);
  const out = new Uint8Array(indices.length * record);
  const view = new DataView(out.buffer);
  indices.forEach((i, r) => {
    const at = r * record;
    const e = buffer.encoded(i);
    view.setUint32(at, buffer.key(i), true);
    view.setUint16(at + 4, buffer.passage(i), true);
    view.setFloat32(at + 6, e.scale, true);
    out.set(new Uint8Array(e.int8.buffer, e.int8.byteOffset, dims), at + 10);
    out.set(e.code, at + 10 + dims);
  });
  return out;
}

/** One list file as loaded: columns over its records. */
export interface ListFile {
  readonly count: number;
  readonly keys: Uint32Array;
  readonly passages: Uint16Array;
  readonly scales: Float32Array;
  readonly int8: Int8Array;
  readonly codes: Uint8Array;
}

export function parseList(data: Uint8Array, dims: number): ListFile {
  const record = listRecordBytes(dims);
  const count = Math.floor(data.length / record);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const keys = new Uint32Array(count);
  const passages = new Uint16Array(count);
  const scales = new Float32Array(count);
  const int8 = new Int8Array(count * dims);
  const codes = new Uint8Array((count * dims) / 8);
  for (let r = 0; r < count; r++) {
    const at = r * record;
    keys[r] = view.getUint32(at, true);
    passages[r] = view.getUint16(at + 4, true);
    scales[r] = view.getFloat32(at + 6, true);
    int8.set(new Int8Array(data.buffer, data.byteOffset + at + 10, dims), r * dims);
    codes.set(data.subarray(at + 10 + dims, at + record), (r * dims) / 8);
  }
  return { count, keys, passages, scales, int8, codes };
}

/** The stored encoding of a list's record (for a merge, which never re-embeds). */
export function listVector(list: ListFile, r: number, dims: number): EncodedVector {
  return {
    scale: list.scales[r] as number,
    int8: list.int8.slice(r * dims, (r + 1) * dims),
    code: list.codes.slice((r * dims) / 8, ((r + 1) * dims) / 8),
  };
}

/** The `probe` lists whose centroids are nearest a normalised query, nearest first. */
export function nearestLists(c: Centroids, query: Float32Array, probe: number): number[] {
  const scores: [number, number][] = [];
  for (let i = 0; i < c.count; i++) {
    let dot = 0;
    for (let j = 0; j < c.dims; j++)
      dot += (query[j] as number) * (c.values[i * c.dims + j] as number);
    scores.push([dot, i]);
  }
  return scores
    .sort((a, b) => b[0] - a[0] || a[1] - b[1])
    .slice(0, Math.min(probe, c.count))
    .map(([, i]) => i);
}

/** Cosine estimate of a normalised query against record `r` of a list. */
export function listScore(list: ListFile, r: number, dims: number, query: Float32Array): number {
  let dot = 0;
  const base = r * dims;
  for (let j = 0; j < dims; j++) dot += (query[j] as number) * (list.int8[base + j] as number);
  return dot * (list.scales[r] as number);
}
