// SPDX-License-Identifier: MPL-2.0

/**
 * Passage vectors (epic #1644, R2/R3, R7).
 *
 * Each vector is stored twice: as a binary code (one bit per dimension, the
 * sign) and as int8 with one float32 scale. A query first ranks every live
 * passage of a flat segment by Hamming distance on the binary codes, then
 * rescores the best candidates with the float query against their int8
 * vectors: {@link defaultRescore} of them, a share of the segment, because
 * the codes are coarse. Measured on real model vectors (#1783,
 * bench/partitions.ts): 200 candidates of 6,633 passages found 95 % of the
 * exhaustive top 10, 1,000 found 99.9 %. Segments large enough that the
 * share stops paying are partitioned instead (partitions.ts). The result is deterministic: it does not depend on what an
 * instance happens to have cached, so a CDN-cached answer and a fresh one
 * agree.
 *
 * Vectors are L2-normalised before quantisation, so the int8 dot product
 * times the scale estimates cosine similarity.
 */

/** A quantised vector. */
export interface EncodedVector {
  readonly code: Uint8Array;
  readonly int8: Int8Array;
  readonly scale: number;
}

/** L2-normalises a copy of `v`. A zero vector stays zero. */
export function normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (const x of v) sum += x * x;
  const out = new Float32Array(v.length);
  if (sum === 0) return out;
  const inv = 1 / Math.sqrt(sum);
  for (let i = 0; i < v.length; i++) out[i] = (v[i] as number) * inv;
  return out;
}

/** The sign bits of `v`, most significant bit first within each byte. */
export function binaryCode(v: Float32Array): Uint8Array {
  const code = new Uint8Array(Math.ceil(v.length / 8));
  for (let i = 0; i < v.length; i++)
    if ((v[i] as number) > 0) code[i >> 3] = (code[i >> 3] as number) | (0x80 >> (i & 7));
  return code;
}

/** Normalises and quantises a vector. */
export function encodeVector(v: Float32Array): EncodedVector {
  const n = normalize(v);
  let max = 0;
  for (const x of n) max = Math.max(max, Math.abs(x));
  const scale = max === 0 ? 0 : max / 127;
  const int8 = new Int8Array(n.length);
  if (scale > 0)
    for (let i = 0; i < n.length; i++)
      int8[i] = Math.max(-127, Math.min(127, Math.round((n[i] as number) / scale)));
  return { code: binaryCode(n), int8, scale };
}

function popcount32(x: number): number {
  let v = x - ((x >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** The share of a flat segment's passages its binary candidates rescore. */
export const RESCORE_SHARE = 0.15;

/** Candidates a flat segment of `count` passages rescores: {@link RESCORE_SHARE} of them, 200 to 5,000. */
export function defaultRescore(count: number): number {
  return Math.min(5000, Math.max(200, Math.ceil(count * RESCORE_SHARE)));
}

/** Keeps the `k` smallest values seen, with their payloads, in a bounded max-heap. */
class BoundedHeap {
  private readonly values: number[] = [];
  private readonly payloads: number[] = [];
  constructor(private readonly k: number) {}

  get worst(): number {
    return this.values.length < this.k ? Number.POSITIVE_INFINITY : (this.values[0] as number);
  }

  push(value: number, payload: number): void {
    if (this.values.length < this.k) {
      this.values.push(value);
      this.payloads.push(payload);
      let i = this.values.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if ((this.values[p] as number) >= (this.values[i] as number)) break;
        this.swap(i, p);
        i = p;
      }
      return;
    }
    if (value >= (this.values[0] as number)) return;
    this.values[0] = value;
    this.payloads[0] = payload;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < this.values.length && (this.values[l] as number) > (this.values[m] as number)) m = l;
      if (r < this.values.length && (this.values[r] as number) > (this.values[m] as number)) m = r;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
  }

  private swap(a: number, b: number): void {
    [this.values[a], this.values[b]] = [this.values[b] as number, this.values[a] as number];
    [this.payloads[a], this.payloads[b]] = [this.payloads[b] as number, this.payloads[a] as number];
  }

  /** Payloads, best (smallest value) first, ties by payload. */
  drain(): number[] {
    return this.values
      .map((v, i) => [v, this.payloads[i] as number] as const)
      .sort((a, b) => a[0] - b[0] || a[1] - b[1])
      .map(([, p]) => p);
  }
}

/** Binary code records of one file: key, passage index and code per record. */
export interface CodeFile {
  readonly count: number;
  readonly keys: Uint32Array;
  readonly passages: Uint16Array;
  /** Codes as 32-bit words, `dims / 32` words per record (dims padded to a multiple of 32). */
  readonly words: Uint32Array;
  readonly wordsPerCode: number;
}

/** Parses a binary code file. */
export function parseCodeFile(data: Uint8Array, dims: number): CodeFile {
  const codeBytes = dims / 8;
  const record = 6 + codeBytes;
  const count = Math.floor(data.length / record);
  const wordsPerCode = Math.ceil(codeBytes / 4);
  const keys = new Uint32Array(count);
  const passages = new Uint16Array(count);
  const words = new Uint32Array(count * wordsPerCode);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i < count; i++) {
    const at = i * record;
    keys[i] = view.getUint32(at, true);
    passages[i] = view.getUint16(at + 4, true);
    for (let w = 0; w < wordsPerCode; w++) {
      let word = 0;
      for (let b = 0; b < 4; b++) {
        const byteIndex = w * 4 + b;
        const byte = byteIndex < codeBytes ? (data[at + 6 + byteIndex] as number) : 0;
        word = (word << 8) | byte;
      }
      words[i * wordsPerCode + w] = word >>> 0;
    }
  }
  return { count, keys, passages, words, wordsPerCode };
}

function codeWords(code: Uint8Array, wordsPerCode: number): Uint32Array {
  const out = new Uint32Array(wordsPerCode);
  for (let w = 0; w < wordsPerCode; w++) {
    let word = 0;
    for (let b = 0; b < 4; b++) word = (word << 8) | (code[w * 4 + b] ?? 0);
    out[w] = word >>> 0;
  }
  return out;
}

/** A position in the code order of one segment: which file and which record. */
export interface CodePosition {
  readonly file: number;
  readonly record: number;
  readonly ordinal: number;
}

/**
 * The `k` passages nearest to `query` by Hamming distance, skipping keys
 * `skip` rejects. Positions are in code order, so the caller can find the
 * int8 block (ordinal / VECTORS_PER_BLOCK).
 */
export function hammingCandidates(
  files: readonly CodeFile[],
  query: Float32Array,
  k: number,
  skip: (key: number) => boolean,
): CodePosition[] {
  if (files.length === 0) return [];
  const wordsPerCode = (files[0] as CodeFile).wordsPerCode;
  const q = codeWords(binaryCode(normalize(query)), wordsPerCode);
  const heap = new BoundedHeap(k);
  const starts: number[] = [];
  let ordinal = 0;
  for (const f of files) {
    starts.push(ordinal);
    for (let i = 0; i < f.count; i++) {
      if (skip(f.keys[i] as number)) continue;
      let d = 0;
      const base = i * wordsPerCode;
      for (let w = 0; w < wordsPerCode; w++)
        d += popcount32(((f.words[base + w] as number) ^ (q[w] as number)) >>> 0);
      if (d < heap.worst) heap.push(d, ordinal + i);
    }
    ordinal += f.count;
  }
  return heap.drain().map((ord) => {
    let fi = starts.length - 1;
    while (fi > 0 && (starts[fi] as number) > ord) fi--;
    return { file: fi, record: ord - (starts[fi] as number), ordinal: ord };
  });
}

/** Cosine estimate of a normalised float query against one int8 vector of a block. */
export function int8Score(
  block: Uint8Array,
  index: number,
  dims: number,
  query: Float32Array,
): number {
  const at = index * (dims + 4);
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
  const scale = view.getFloat32(at, true);
  let dot = 0;
  for (let i = 0; i < dims; i++) {
    const b = block[at + 4 + i] as number;
    dot += (query[i] as number) * (b > 127 ? b - 256 : b);
  }
  return dot * scale;
}

/** Reads one stored vector back in encoded form (for a merge, which never re-embeds). */
export function storedVector(
  codes: CodeFile,
  record: number,
  block: Uint8Array,
  index: number,
  dims: number,
): EncodedVector {
  const codeBytes = dims / 8;
  const code = new Uint8Array(codeBytes);
  for (let b = 0; b < codeBytes; b++) {
    const word = codes.words[record * codes.wordsPerCode + (b >> 2)] as number;
    code[b] = (word >>> (24 - 8 * (b & 3))) & 0xff;
  }
  const at = index * (dims + 4);
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
  const scale = view.getFloat32(at, true);
  const int8 = new Int8Array(dims);
  for (let i = 0; i < dims; i++) {
    const b = block[at + 4 + i] as number;
    int8[i] = b > 127 ? b - 256 : b;
  }
  return { code, int8, scale };
}
