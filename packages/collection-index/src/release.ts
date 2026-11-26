// SPDX-License-Identifier: MPL-2.0

/**
 * Collection releases (epic #1644, R2).
 *
 * A release names the segments of one collection at one Stage, with the keys
 * each segment no longer owns. A document id resolves to its key through the
 * id term every segment indexes, so a release carries no key map and a Stage
 * writes data of size O(changes), not O(collection). It is a content-addressed JSON file like every other file of the
 * collection, so a Stage freezes a collection by naming one release file,
 * Publish live copies the files the live store lacks and points at the same
 * name, and a rollback points back.
 *
 * `applyChanges` is the indexing job's step: it turns the previous release
 * and a batch of upserts and deletes into the next release. A changed
 * document keeps its key; its old copy joins the old segment's removed set.
 * The changed documents become one new delta segment, unless the merge
 * policy says the release has too many segments or too many removed
 * documents, in which case every live document is rewritten into one
 * segment (vectors carried over, never re-embedded).
 *
 * Both steps embed only passage text the collection does not hold yet
 * (vector-pool.ts): a changed document keeps the vectors of its unchanged
 * passages, and a rebuild under the same model keeps every vector whose
 * text it still has.
 */

import { ByteReader, ByteWriter } from "./bytes.js";
import { type FileCacheLike, SegmentReader } from "./reader.js";
import {
  type CollectionDoc,
  type CollectionSchema,
  idTerm,
  type KeyedDoc,
  layoutOf,
} from "./schema.js";
import type { SegmentManifest } from "./segment.js";
import {
  addReleaseVectors,
  type EmbedTexts,
  type PassageCounts,
  type PassageVector,
  passageCounts,
  passagesOf,
  segmentVectors,
  VectorPool,
  vectorsFor,
} from "./vector-pool.js";
import type { EncodedVector } from "./vectors.js";
import { contentName, type FileSink, SegmentWriter } from "./writer.js";

export { passageEmbeddingText } from "./vector-pool.js";

/** One segment of a release. */
export interface ReleaseSegment {
  readonly manifest: string;
  /** File of keys this segment no longer owns, or null. */
  readonly removed: string | null;
  readonly docCount: number;
  readonly removedCount: number;
}

/** The release file. */
export interface ReleaseManifest {
  readonly format: 1;
  readonly schemaDigest: string;
  readonly segments: readonly ReleaseSegment[];
  readonly nextKey: number;
  readonly docCount: number;
  readonly vectorModel: { readonly id: string; readonly dims: number } | null;
  /** The search profile's file (JSON), or null when the plugin set none. */
  readonly profile: string | null;
}

/** A release opened for reading. */
export interface OpenRelease {
  readonly manifest: ReleaseManifest;
  readonly segments: readonly {
    readonly reader: SegmentReader;
    readonly removed: ReadonlySet<number>;
  }[];
}

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder();

/** A stable digest of a schema: a release built for another schema is never read with this one. */
export function schemaDigest(schema: CollectionSchema): string {
  layoutOf(schema);
  const canonical = JSON.stringify(
    Object.entries(schema.fields).map(([name, spec]) => [name, Object.entries(spec).sort()]),
  );
  return contentName("x", utf8.encode(canonical), "schema").slice(2, 26);
}

function encodeKeys(keys: Iterable<number>): Uint8Array {
  const sorted = [...keys].sort((a, b) => a - b);
  const w = new ByteWriter(sorted.length * 3 + 4);
  w.uint(sorted.length);
  let prev = 0;
  for (const k of sorted) {
    w.uint(k - prev);
    prev = k;
  }
  return w.finish();
}

function decodeKeys(data: Uint8Array): Set<number> {
  const r = new ByteReader(data);
  const n = r.uint();
  const out = new Set<number>();
  let k = 0;
  for (let i = 0; i < n; i++) {
    k += r.uint();
    out.add(k);
  }
  return out;
}

function parseJson<T>(data: Uint8Array): T {
  return JSON.parse(utf8Decoder.decode(data)) as T;
}

/** Opens a release: its segment manifests and removed sets load now, everything else on demand. */
export async function openRelease(
  manifest: ReleaseManifest,
  cache: FileCacheLike,
): Promise<OpenRelease> {
  if (manifest.format !== 1)
    throw new RangeError(
      `release format ${String(manifest.format)} is not supported by this engine`,
    );
  const segments = await Promise.all(
    manifest.segments.map(async (s) => {
      const [m, removed] = await Promise.all([
        cache.get(s.manifest, (d) => parseJson<SegmentManifest>(d)),
        s.removed ? cache.get(s.removed, decodeKeys) : Promise.resolve(new Set<number>()),
      ]);
      return { reader: new SegmentReader(m, cache), removed };
    }),
  );
  return { manifest, segments };
}

/** Reads a release file. */
export function parseRelease(data: Uint8Array): ReleaseManifest {
  return parseJson<ReleaseManifest>(data);
}

/** Where each id lives in a release: segment index and key, for ids that are live. */
export async function locateDocs(
  opened: OpenRelease,
  ids: readonly string[],
): Promise<Map<string, { segment: number; key: number }>> {
  const out = new Map<string, { segment: number; key: number }>();
  for (let si = 0; si < opened.segments.length; si++) {
    const seg = opened.segments[si] as OpenRelease["segments"][number];
    const lists = await Promise.all(ids.map((id) => seg.reader.postings(idTerm(id))));
    lists.forEach((list, i) => {
      for (const key of list?.keys ?? [])
        if (!seg.removed.has(key)) out.set(ids[i] as string, { segment: si, key });
    });
  }
  return out;
}

/** When a release is rewritten into one segment. */
export interface MergePolicy {
  /** Most segments a release may have before a merge. */
  readonly maxSegments: number;
  /** Highest share of removed documents across the release before a merge. */
  readonly maxRemovedShare: number;
}

/** Default merge policy: at most 8 segments, at most a quarter of the stored documents removed. */
export const DEFAULT_MERGE_POLICY: MergePolicy = { maxSegments: 8, maxRemovedShare: 0.25 };

/** One batch of changes for a collection. */
export interface CollectionChanges {
  readonly upserts: readonly CollectionDoc[];
  readonly deletes: readonly string[];
}

/** Options of {@link applyChanges}. */
export interface ApplyOptions {
  readonly schema: CollectionSchema;
  readonly sink: FileSink;
  /** Reads the previous release's files. */
  readonly cache: FileCacheLike;
  /** Embeds passage texts; required when the schema has a vector field. */
  readonly embed?: EmbedTexts;
  /**
   * Vectors already known by passage text, of this release's model. The
   * build takes from it before embedding and adds what it embeds;
   * `applyChanges` also adds the previous vectors of the documents it
   * changes. Omitted: a pool of its own.
   */
  readonly reuse?: VectorPool;
  readonly vectorModel?: { readonly id: string; readonly dims: number };
  readonly mergePolicy?: MergePolicy;
  /** Rewrite into one segment regardless of the policy (a rebuild). */
  readonly forceMerge?: boolean;
  readonly protectedTerms?: ReadonlySet<string>;
  /** A new search profile (JSON), or undefined to keep the previous release's. */
  readonly profile?: unknown;
}

/** What `applyChanges` produced. */
export interface AppliedRelease {
  readonly manifest: ReleaseManifest;
  readonly file: string;
  readonly merged: boolean;
  readonly bytesWritten: number;
  /** Passages embedded and passages that kept a known vector. */
  readonly passages: PassageCounts;
}

/**
 * Produces the next release from `previous` (null for the first) and
 * `changes`. Upserting an unchanged document is the caller's to avoid; the
 * engine rewrites whatever it is given.
 */
export async function applyChanges(
  previous: ReleaseManifest | null,
  changes: CollectionChanges,
  o: ApplyOptions,
): Promise<AppliedRelease> {
  const layout = layoutOf(o.schema);
  const digest = schemaDigest(o.schema);
  const vectorField = layout.vectorFields[0];
  if (vectorField && o.vectorModel && !o.embed)
    throw new RangeError("applyChanges: a vector model needs `embed`");
  if (previous && previous.schemaDigest !== digest)
    throw new RangeError(
      "applyChanges: the previous release was built for another schema; rebuild from the documents",
    );
  if (
    previous &&
    (previous.vectorModel?.id ?? null) !== (vectorField ? (o.vectorModel?.id ?? null) : null)
  ) {
    throw new RangeError(
      "applyChanges: the previous release used another vector model (or none); rebuild from the documents",
    );
  }
  let bytesWritten = 0;
  const sink: FileSink = (name, data) => {
    bytesWritten += data.length;
    o.sink(name, data);
  };

  const opened = previous ? await openRelease(previous, o.cache) : null;
  const removed = (opened?.segments ?? []).map((s) => new Set(s.removed));
  let nextKey = previous?.nextKey ?? 1;

  const upserts = new Map<string, CollectionDoc>();
  for (const d of changes.upserts) upserts.set(d.id, d);
  for (const id of changes.deletes) upserts.delete(id);
  const touched = [...new Set([...changes.deletes, ...upserts.keys()])];
  const located = opened
    ? await locateDocs(opened, touched)
    : new Map<string, { segment: number; key: number }>();
  for (const id of touched) {
    const at = located.get(id);
    if (at) removed[at.segment]?.add(at.key);
  }
  const keyed: KeyedDoc[] = [];
  for (const [id, doc] of upserts) {
    const key = located.get(id)?.key ?? nextKey++;
    keyed.push({ ...doc, key });
  }
  keyed.sort((a, b) => a.key - b.key);

  // A changed document's unchanged passages keep their vectors.
  const pool = o.reuse ?? new VectorPool();
  if (vectorField && o.vectorModel && opened) {
    const previousKeys = new Map<number, Set<number>>();
    for (const id of upserts.keys()) {
      const at = located.get(id);
      if (at)
        (
          previousKeys.get(at.segment) ?? previousKeys.set(at.segment, new Set()).get(at.segment)
        )?.add(at.key);
    }
    await addReleaseVectors(pool, opened, vectorField, previousKeys);
  }
  const counts = passageCounts();

  const storedTotal =
    (opened?.segments ?? []).reduce((n, s) => n + s.reader.manifest.docCount, 0) + keyed.length;
  const removedTotal = removed.reduce((n, s) => n + s.size, 0);
  const policy = o.mergePolicy ?? DEFAULT_MERGE_POLICY;
  const merge =
    (o.forceMerge ?? false) ||
    (opened !== null && opened.segments.length + 1 > policy.maxSegments) ||
    (storedTotal > 0 && removedTotal / storedTotal > policy.maxRemovedShare);

  const embedDocs = async (docs: readonly KeyedDoc[]): Promise<Map<number, PassageVector[]>> => {
    if (!vectorField || !o.embed || !o.vectorModel) return new Map();
    return vectorsFor(docs, vectorField, o.embed, pool, counts);
  };

  const writerFor = async (vocabularyFrom: OpenRelease | null): Promise<SegmentWriter> => {
    const vocabulary = new Map<string, number>();
    if (vocabularyFrom) {
      const buckets = new Set<string>();
      for (const s of vocabularyFrom.segments)
        for (const b of Object.keys(s.reader.manifest.vocabulary)) buckets.add(b);
      for (const s of vocabularyFrom.segments) {
        for (const b of buckets)
          for (const w of await s.reader.vocabulary(b))
            vocabulary.set(w.word, (vocabulary.get(w.word) ?? 0) + w.df);
      }
    }
    return new SegmentWriter({
      schema: o.schema,
      sink,
      vocabulary,
      dims: o.vectorModel?.dims,
      protectedTerms: o.protectedTerms,
    });
  };

  const segments: ReleaseSegment[] = [];
  if (merge) {
    const writer = await writerFor(null);
    const fresh = await embedDocs(keyed);
    const pending = [...keyed];
    let pi = 0;
    // Old documents and changed ones interleave in key order; a changed key's old copy is in a removed set.
    const old = opened ? await liveDocsInKeyOrder(opened, removed) : [];
    let oi = 0;
    while (oi < old.length || pi < pending.length) {
      const o1 = old[oi];
      const p1 = pending[pi];
      if (p1 && (!o1 || p1.key < o1.doc.key)) {
        writer.add(p1, fresh.get(p1.key));
        pi++;
      } else if (o1) {
        writer.add(o1.doc, o1.vectors);
        oi++;
      }
    }
    const written = writer.finish();
    segments.push({
      manifest: written.manifestFile,
      removed: null,
      docCount: written.manifest.docCount,
      removedCount: 0,
    });
  } else {
    (opened?.segments ?? []).forEach((s, i) => {
      const r = removed[i] as Set<number>;
      const file = r.size > 0 ? contentName("r", encodeKeys(r), "bin") : null;
      if (file) sink(file, encodeKeys(r));
      segments.push({
        manifest: (previous as ReleaseManifest).segments[i]?.manifest as string,
        removed: file,
        docCount: s.reader.manifest.docCount,
        removedCount: r.size,
      });
    });
    if (keyed.length > 0) {
      const writer = await writerFor(opened);
      const fresh = await embedDocs(keyed);
      for (const d of keyed) writer.add(d, fresh.get(d.key));
      const written = writer.finish();
      segments.push({
        manifest: written.manifestFile,
        removed: null,
        docCount: written.manifest.docCount,
        removedCount: 0,
      });
    }
  }

  const manifest: ReleaseManifest = {
    format: 1,
    schemaDigest: digest,
    segments,
    nextKey,
    docCount: segments.reduce((n, s) => n + s.docCount - s.removedCount, 0),
    vectorModel:
      vectorField && o.vectorModel ? { id: o.vectorModel.id, dims: o.vectorModel.dims } : null,
    profile: o.profile === undefined ? (previous?.profile ?? null) : writeProfile(o.profile, sink),
  };
  const data = utf8.encode(JSON.stringify(manifest));
  const file = contentName("release", data, "json");
  sink(file, data);
  return { manifest, file, merged: merge, bytesWritten, passages: counts };
}

/** Options of {@link buildRelease}. */
export interface BuildOptions extends Omit<ApplyOptions, "cache" | "mergePolicy" | "forceMerge"> {
  /** Passages embedded per `embed` call. */
  readonly embedBatch?: number;
}

/**
 * Builds a release from scratch out of a stream of documents: the first
 * build, and every rebuild from the documents. Keys are assigned in stream
 * order from 1; memory stays one embedding batch plus the writer's chunk.
 */
export async function buildRelease(
  docs: AsyncIterable<CollectionDoc> | Iterable<CollectionDoc>,
  o: BuildOptions,
): Promise<AppliedRelease> {
  const layout = layoutOf(o.schema);
  const vectorField = layout.vectorFields[0];
  if (vectorField && o.vectorModel && !o.embed)
    throw new RangeError("buildRelease: a vector model needs `embed`");
  let bytesWritten = 0;
  const sink: FileSink = (name, data) => {
    bytesWritten += data.length;
    o.sink(name, data);
  };
  const writer = new SegmentWriter({
    schema: o.schema,
    sink,
    dims: o.vectorModel?.dims,
    protectedTerms: o.protectedTerms,
  });
  const seen = new Set<string>();
  let key = 0;
  let batch: KeyedDoc[] = [];
  let passages = 0;
  const pool = o.reuse ?? new VectorPool();
  const counts = passageCounts();
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const vectors =
      vectorField && o.embed && o.vectorModel
        ? await vectorsFor(batch, vectorField, o.embed, pool, counts)
        : new Map<number, PassageVector[]>();
    for (const d of batch) writer.add(d, vectors.get(d.key));
    batch = [];
    passages = 0;
  };
  for await (const doc of docs) {
    if (seen.has(doc.id))
      throw new RangeError(`buildRelease: document id "${doc.id}" appears twice`);
    seen.add(doc.id);
    batch.push({ ...doc, key: ++key });
    if (vectorField && o.vectorModel) passages += passagesOf(doc, vectorField).length;
    if (batch.length >= 256 || passages >= (o.embedBatch ?? 64)) await flush();
  }
  await flush();
  const written = writer.finish();
  const manifest: ReleaseManifest = {
    format: 1,
    schemaDigest: schemaDigest(o.schema),
    segments: [
      {
        manifest: written.manifestFile,
        removed: null,
        docCount: written.manifest.docCount,
        removedCount: 0,
      },
    ],
    nextKey: key + 1,
    docCount: written.manifest.docCount,
    vectorModel:
      vectorField && o.vectorModel ? { id: o.vectorModel.id, dims: o.vectorModel.dims } : null,
    profile: o.profile === undefined ? null : writeProfile(o.profile, sink),
  };
  const data = utf8.encode(JSON.stringify(manifest));
  const file = contentName("release", data, "json");
  sink(file, data);
  return { manifest, file, merged: true, bytesWritten, passages: counts };
}

/** Every live document of a release with its stored vectors, ascending by key. */
async function liveDocsInKeyOrder(
  opened: OpenRelease,
  removed: readonly ReadonlySet<number>[],
): Promise<{ doc: KeyedDoc; vectors?: (EncodedVector | null)[] }[]> {
  const out: { doc: KeyedDoc; vectors?: (EncodedVector | null)[] }[] = [];
  for (let si = 0; si < opened.segments.length; si++) {
    const seg = opened.segments[si] as OpenRelease["segments"][number];
    const gone = removed[si] as ReadonlySet<number>;
    const vectors = await segmentVectors(seg.reader, null);
    for await (const doc of seg.reader.allStored()) {
      if (gone.has(doc.key)) continue;
      out.push({ doc, vectors: vectors.get(doc.key) });
    }
  }
  return out.sort((a, b) => a.doc.key - b.doc.key);
}

/** Writes a profile as a content-addressed JSON file and returns its name. */
function writeProfile(profile: unknown, sink: FileSink): string {
  const data = utf8.encode(JSON.stringify(profile));
  const file = contentName("p", data, "json");
  sink(file, data);
  return file;
}

/** Reads a release's search profile, or null when it has none. */
export async function readProfile(
  release: ReleaseManifest,
  cache: FileCacheLike,
): Promise<unknown | null> {
  if (!release.profile) return null;
  return cache.get(release.profile, (d) => parseJson<unknown>(d));
}

/** Every file a release references, for copies and garbage collection. */
export async function releaseFiles(
  manifest: ReleaseManifest,
  cache: FileCacheLike,
): Promise<Set<string>> {
  const files = new Set<string>(manifest.profile ? [manifest.profile] : []);
  for (const s of manifest.segments) {
    files.add(s.manifest);
    if (s.removed) files.add(s.removed);
    const m = await cache.get(s.manifest, (d) => parseJson<SegmentManifest>(d));
    files.add(m.docsFile);
    for (const x of m.shards) files.add(x.file);
    for (const x of m.stores) files.add(x.file);
    for (const x of Object.values(m.vocabulary)) files.add(x);
    for (const x of m.vectors?.codes ?? []) files.add(x);
    for (const x of m.vectors?.blocks ?? []) files.add(x);
  }
  return files;
}

/** Looks up live documents by id or by a keyword value, across the release. */
export async function lookupDocs(
  release: OpenRelease,
  terms: readonly string[],
): Promise<KeyedDoc[]> {
  const out: KeyedDoc[] = [];
  for (const seg of release.segments) {
    const keys = new Set<number>();
    for (const t of terms) {
      const list = await seg.reader.postings(t);
      if (list) for (const k of list.keys) if (!seg.removed.has(k)) keys.add(k);
    }
    if (keys.size === 0) continue;
    const docs = await seg.reader.stored([...keys]);
    for (const k of keys) {
      const d = docs.get(k);
      if (d) out.push(d);
    }
  }
  return out.sort((a, b) => a.key - b.key);
}
