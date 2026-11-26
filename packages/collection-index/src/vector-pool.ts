// SPDX-License-Identifier: MPL-2.0

/**
 * Passage vectors a collection already holds, found by their text: a Stage
 * embeds only text it has not embedded before.
 *
 * A passage's vector is a function of its text and the model. The embedder
 * runs one text per call, never a padded batch (packages/models
 * embedder.ts), so the same text under the same model gives the same
 * vector. The pool therefore hands out the stored encoding of a text a
 * document still carries, and a release built from it holds what a full
 * re-embedding would have quantised to. It is only ever filled from a
 * release of the same model: `applyChanges` refuses a previous release of
 * another model, and the index job builds a pool only when the model
 * fingerprints match.
 *
 * Entries are keyed by the text's SHA-256, so the pool holds no passage
 * text. A full pool of a 50,000-page site (about 800,000 passages) costs
 * roughly 300 MB besides the vector blocks it points into.
 *
 * Without it, every Stage embedded every passage of every document it was
 * handed, and every rebuild every passage of the collection. On
 * searchviu.com a full build was 5,152 passages and 13.5 minutes
 * (2026-11-26); a Caelo update that re-renders every page hands every
 * document to the index again.
 */

import { createHash } from "node:crypto";
import type { SegmentReader } from "./reader.js";
import type { OpenRelease } from "./release.js";
import type { CollectionDoc, KeyedDoc, Passage } from "./schema.js";
import { VECTORS_PER_BLOCK } from "./segment.js";
import { type EncodedVector, encodeVector, storedVector } from "./vectors.js";

/** A vector the segment writer takes: freshly embedded, or as a release stores it. */
export type PassageVector = Float32Array | EncodedVector;

/** Embeds passage texts, one vector per text, in order. */
export type EmbedTexts = (texts: readonly string[]) => Promise<readonly Float32Array[]>;

/** The text a passage is embedded from: its heading and text. */
export function passageEmbeddingText(p: Passage): string {
  return p.heading ? `${p.heading}\n${p.text}` : p.text;
}

/** The passages of a document's vector field, or none. */
export function passagesOf(doc: CollectionDoc, field: string): readonly Passage[] {
  const v = doc.values[field];
  return Array.isArray(v) ? (v as readonly Passage[]) : [];
}

/** Encoded vectors by passage text, all of one model. */
export class VectorPool {
  readonly #byKey = new Map<string, EncodedVector>();

  /** The key of a text: its SHA-256, base64. */
  static keyOf(text: string): string {
    return createHash("sha256").update(text).digest("base64");
  }

  get size(): number {
    return this.#byKey.size;
  }

  getByKey(key: string): EncodedVector | undefined {
    return this.#byKey.get(key);
  }

  /** Stores the encoding, so a fresh vector costs what the release stores (about 440 bytes). */
  setByKey(key: string, v: PassageVector): void {
    this.#byKey.set(key, v instanceof Float32Array ? encodeVector(v) : v);
  }

  get(text: string): EncodedVector | undefined {
    return this.#byKey.get(VectorPool.keyOf(text));
  }

  set(text: string, v: PassageVector): void {
    this.setByKey(VectorPool.keyOf(text), v);
  }
}

/** What became of the passages a build handed to {@link vectorsFor}. */
export interface PassageCounts {
  /** Distinct texts sent to the model. */
  embedded: number;
  /** Passages that took a vector the pool or the batch already had. */
  reused: number;
}

/** Fresh counters. */
export function passageCounts(): PassageCounts {
  return { embedded: 0, reused: 0 };
}

/**
 * The vectors of `docs`' passages: from `pool` where it knows the text,
 * otherwise embedded, once per distinct text, and added to it. The vectors
 * come back by document key, in passage order.
 */
export async function vectorsFor(
  docs: readonly KeyedDoc[],
  field: string,
  embed: EmbedTexts,
  pool: VectorPool,
  counts: PassageCounts,
): Promise<Map<number, PassageVector[]>> {
  const out = new Map<number, PassageVector[]>();
  const missing = new Map<string, { text: string; owners: [number, number][] }>();
  for (const d of docs) {
    const list: PassageVector[] = [];
    out.set(d.key, list);
    passagesOf(d, field).forEach((p, i) => {
      const text = passageEmbeddingText(p);
      const key = VectorPool.keyOf(text);
      const known = pool.getByKey(key);
      if (known) {
        list[i] = known;
        counts.reused++;
        return;
      }
      const m = missing.get(key);
      if (m) m.owners.push([d.key, i]);
      else missing.set(key, { text, owners: [[d.key, i]] });
    });
  }
  if (missing.size === 0) return out;
  const pending = [...missing];
  const fresh = await embed(pending.map(([, m]) => m.text));
  if (fresh.length !== pending.length)
    throw new RangeError(`embed returned ${fresh.length} vectors for ${pending.length} passages`);
  pending.forEach(([key, m], at) => {
    const v = fresh[at] as Float32Array;
    pool.setByKey(key, v);
    counts.embedded++;
    counts.reused += m.owners.length - 1;
    for (const [docKey, i] of m.owners) (out.get(docKey) as PassageVector[])[i] = v;
  });
  return out;
}

/**
 * The encoded vectors of a segment by document key and passage, for every
 * document or only `keys`. A document's passages are adjacent in code
 * order, so only the int8 blocks holding wanted documents are read.
 */
export async function segmentVectors(
  reader: SegmentReader,
  keys: ReadonlySet<number> | null = null,
): Promise<Map<number, (EncodedVector | null)[]>> {
  const out = new Map<number, (EncodedVector | null)[]>();
  const v = reader.manifest.vectors;
  if (!v) return out;
  const files = await reader.codeFiles();
  let ordinal = 0;
  for (const f of files) {
    for (let i = 0; i < f.count; i++, ordinal++) {
      const key = f.keys[i] as number;
      if (keys && !keys.has(key)) continue;
      const block = await reader.vectorBlock(Math.floor(ordinal / VECTORS_PER_BLOCK));
      const encoded = storedVector(f, i, block, ordinal % VECTORS_PER_BLOCK, v.dims);
      const list = out.get(key) ?? out.set(key, []).get(key);
      if (list) list[f.passages[i] as number] = encoded;
    }
  }
  return out;
}

/**
 * Adds the vectors of `opened`'s live documents to `pool`: every document,
 * or with `keys` (per segment index) only those, as a Stage that changes
 * them needs. Adds nothing from a release without vectors or with another
 * vector field.
 */
export async function addReleaseVectors(
  pool: VectorPool,
  opened: OpenRelease,
  field: string,
  keys: ReadonlyMap<number, ReadonlySet<number>> | null = null,
): Promise<VectorPool> {
  if (!opened.manifest.vectorModel) return pool;
  for (let si = 0; si < opened.segments.length; si++) {
    const seg = opened.segments[si] as OpenRelease["segments"][number];
    if (seg.reader.manifest.vectors?.field !== field) continue;
    const wanted = keys ? keys.get(si) : null;
    if (keys && (!wanted || wanted.size === 0)) continue;
    const vectors = await segmentVectors(seg.reader, wanted ?? null);
    const add = (doc: KeyedDoc): void => {
      const list = vectors.get(doc.key);
      if (!list) return;
      passagesOf(doc, field).forEach((p, i) => {
        const e = list[i];
        if (e) pool.set(passageEmbeddingText(p), e);
      });
    };
    if (wanted) {
      for (const doc of (await seg.reader.stored([...wanted])).values()) add(doc);
    } else {
      for await (const doc of seg.reader.allStored()) if (!seg.removed.has(doc.key)) add(doc);
    }
  }
  return pool;
}

/** "CVS1": the first four bytes of a vector shard file. */
const SHARD_MAGIC = 0x31535643;

/**
 * A file of vectors one task of a wide index attempt embedded: each text's
 * key with its encoding, so the task that builds the release adds them to
 * its pool. Layout (little-endian): magic, dims, count (u32 each), then
 * per entry the key's 32 SHA-256 bytes, the scale (f32), the int8 vector
 * and the binary code.
 */
export function encodeVectorShard(
  entries: readonly (readonly [string, EncodedVector])[],
  dims: number,
): Uint8Array {
  const codeBytes = dims / 8;
  const record = 32 + 4 + dims + codeBytes;
  const out = new Uint8Array(12 + entries.length * record);
  const view = new DataView(out.buffer);
  view.setUint32(0, SHARD_MAGIC, true);
  view.setUint32(4, dims, true);
  view.setUint32(8, entries.length, true);
  entries.forEach(([key, v], i) => {
    const at = 12 + i * record;
    const hash = Buffer.from(key, "base64");
    if (hash.length !== 32) throw new RangeError(`not a SHA-256 key: ${key}`);
    if (v.int8.length !== dims || v.code.length !== codeBytes)
      throw new RangeError(`a vector of ${v.int8.length} dimensions in a shard of ${dims}`);
    out.set(hash, at);
    view.setFloat32(at + 32, v.scale, true);
    out.set(new Uint8Array(v.int8.buffer, v.int8.byteOffset, dims), at + 36);
    out.set(v.code, at + 36 + dims);
  });
  return out;
}

/** The entries of a vector shard file; throws on a file of another layout or dimension. */
export function decodeVectorShard(data: Uint8Array, dims: number): [string, EncodedVector][] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < 12 || view.getUint32(0, true) !== SHARD_MAGIC)
    throw new RangeError("not a vector shard file");
  if (view.getUint32(4, true) !== dims)
    throw new RangeError(
      `a vector shard of ${view.getUint32(4, true)} dimensions, expected ${dims}`,
    );
  const count = view.getUint32(8, true);
  const codeBytes = dims / 8;
  const record = 32 + 4 + dims + codeBytes;
  if (data.length !== 12 + count * record) throw new RangeError("a truncated vector shard file");
  const out: [string, EncodedVector][] = [];
  for (let i = 0; i < count; i++) {
    const at = 12 + i * record;
    const key = Buffer.from(data.subarray(at, at + 32)).toString("base64");
    const scale = view.getFloat32(at + 32, true);
    const int8 = new Int8Array(data.slice(at + 36, at + 36 + dims).buffer);
    const code = data.slice(at + 36 + dims, at + record);
    out.push([key, { code, int8, scale }]);
  }
  return out;
}
