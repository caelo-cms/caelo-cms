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
import {
  type FileCacheLike,
  type FileFormat,
  type FileLoad,
  jsonFormat,
  SegmentReader,
} from "./reader.js";
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
  VectorPool,
  vectorsFor,
} from "./vector-pool.js";
import type { EncodedVector } from "./vectors.js";
import { contentName, type FileSink, type SegmentTuning, SegmentWriter } from "./writer.js";

export { passageEmbeddingText } from "./vector-pool.js";

/** One segment of a release. */
export interface ReleaseSegment {
  readonly manifest: string;
  /** File of keys this segment no longer owns, or null. */
  readonly removed: string | null;
  readonly docCount: number;
  readonly removedCount: number;
}

/**
 * The release format this engine writes. 2: every segment is format 3
 * (segment.ts). A release of format 1 is read, never extended: the index
 * job rebuilds it (`releaseNeedsRebuild`).
 */
export const RELEASE_FORMAT = 2;

/** The release file. */
export interface ReleaseManifest {
  readonly format: 1 | 2;
  readonly schemaDigest: string;
  readonly segments: readonly ReleaseSegment[];
  readonly nextKey: number;
  readonly docCount: number;
  readonly vectorModel: { readonly id: string; readonly dims: number } | null;
  /** The search profile's file (JSON), or null when the plugin set none. */
  readonly profile: string | null;
  /** Keyword fields stored per document in every segment's docs file (format 2). */
  readonly columns?: readonly string[];
}

/**
 * Whether the next release must be built from the documents instead of as
 * a delta on `previous`: an older format, or other keyword columns.
 */
export function releaseNeedsRebuild(
  previous: ReleaseManifest,
  columns: readonly string[] = [],
): boolean {
  if (previous.format !== RELEASE_FORMAT) return true;
  const had = [...(previous.columns ?? [])].sort().join("\n");
  return had !== [...columns].sort().join("\n");
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

const SEGMENT_MANIFEST_FORMAT = jsonFormat<SegmentManifest>();
const PROFILE_FORMAT = jsonFormat<unknown>();
/** A removed set: about 48 bytes per key in a Set. */
const REMOVED_FORMAT: FileFormat<Set<number>> = {
  parse: decodeKeys,
  bytes: (v) => 64 + v.size * 48,
};

/** Opens a release: its segment manifests and removed sets load now, everything else on demand. */
export async function openRelease(
  manifest: ReleaseManifest,
  cache: FileCacheLike,
): Promise<OpenRelease> {
  if (manifest.format !== 1 && manifest.format !== 2)
    throw new RangeError(
      `release format ${String(manifest.format)} is not supported by this engine`,
    );
  const segments = await Promise.all(
    manifest.segments.map(async (s) => {
      const [m, removed] = await Promise.all([
        cache.get(s.manifest, SEGMENT_MANIFEST_FORMAT),
        s.removed ? cache.get(s.removed, REMOVED_FORMAT) : Promise.resolve(new Set<number>()),
      ]);
      return { reader: new SegmentReader(m, cache), removed };
    }),
  );
  return { manifest, segments };
}

/** What {@link prefetchRelease} may do. */
export interface PrefetchOptions {
  /** Files loading at once (default {@link PREFETCH_PARALLEL}). */
  readonly parallel?: number;
  /**
   * Asked before each file: false ends the prefetch. The gateway passes
   * "the cache holds less than its share of the budget", so a release that
   * does not fit keeps the files every query needs and the rest loads on
   * demand.
   */
  readonly mayLoad?: () => boolean;
}

/** What one prefetch loaded. */
export interface PrefetchReport {
  /** Files now in the cache (loaded by this prefetch or already there). */
  readonly files: number;
  /** Files of the release it did not reach, because `mayLoad` said no. */
  readonly skipped: number;
  /** Files whose load failed, and the first failure (a query needing one reads it again, and fails loudly). */
  readonly failed: number;
  readonly firstError: string | null;
}

/** Object-store reads one prefetch keeps in flight. */
export const PREFETCH_PARALLEL = 16;

/**
 * Loads the files of an opened release into its cache, in parallel, the
 * files every query needs first (SegmentReader.fileLoads: documents and
 * term shards of every segment, then vocabulary, vector codes, stored
 * documents and vector blocks). A query after it reads nothing from the
 * store for the files it loaded. Never rejects: a failed file is counted
 * and left to the query that needs it.
 */
export async function prefetchRelease(
  opened: OpenRelease,
  options: PrefetchOptions = {},
): Promise<PrefetchReport> {
  const loads: FileLoad[] = [];
  const seen = new Set<string>();
  const tiers = opened.segments.map((s) => s.reader.fileLoads());
  const depth = Math.max(0, ...tiers.map((t) => t.length));
  for (let tier = 0; tier < depth; tier++) {
    for (const segment of tiers) {
      for (const load of segment[tier] ?? []) {
        if (seen.has(load.file)) continue;
        seen.add(load.file);
        loads.push(load);
      }
    }
  }
  let next = 0;
  let files = 0;
  let failed = 0;
  let firstError: string | null = null;
  let stopped = false;
  const worker = async (): Promise<void> => {
    while (!stopped && next < loads.length) {
      if (options.mayLoad && !options.mayLoad()) {
        stopped = true;
        return;
      }
      const load = loads[next++] as FileLoad;
      try {
        await load.load();
        files++;
      } catch (e) {
        failed++;
        firstError ??= `${load.file}: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
  };
  const parallel = Math.max(1, Math.min(options.parallel ?? PREFETCH_PARALLEL, loads.length));
  await Promise.all(Array.from({ length: parallel }, worker));
  return { files, skipped: loads.length - files - failed, failed, firstError };
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

/** When a release is rewritten into one segment, or its newer segments into one. */
export interface MergePolicy {
  /** Most segments a release may have before a merge. */
  readonly maxSegments: number;
  /** Highest share of removed documents across the release before a merge. */
  readonly maxRemovedShare: number;
  /**
   * Live documents up to which the release is always one segment, and up
   * to which its newer segments (everything after the first) are always
   * rewritten into one (#1781). Rewriting a few thousand documents costs a
   * Stage seconds; every extra segment costs every cold query another
   * round of reads for its files.
   */
  readonly floorDocs: number;
}

/**
 * Default merge policy: one segment up to 2,000 live documents, at most two
 * while the newer documents stay within that, at most 8 segments and a
 * quarter of the stored documents removed.
 */
export const DEFAULT_MERGE_POLICY: MergePolicy = {
  maxSegments: 8,
  maxRemovedShare: 0.25,
  floorDocs: 2000,
};

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
  /** Keyword fields stored per document (the operations that read a value per hit name them). */
  readonly columns?: readonly string[];
  /** How segments are cut into files (tests and benchmarks; production keeps the defaults). */
  readonly tuning?: SegmentTuning;
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
  if (previous && releaseNeedsRebuild(previous, o.columns))
    throw new RangeError(
      "applyChanges: the previous release has an older format or other keyword columns; rebuild from the documents",
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

  const policy = o.mergePolicy ?? DEFAULT_MERGE_POLICY;
  const segs = opened?.segments ?? [];
  const storedTotal = segs.reduce((n, s) => n + s.reader.manifest.docCount, 0) + keyed.length;
  const removedTotal = removed.reduce((n, s) => n + s.size, 0);
  const liveOf = (i: number): number =>
    (segs[i]?.reader.manifest.docCount ?? 0) - (removed[i]?.size ?? 0);
  const liveTotal = storedTotal - removedTotal;
  // Live documents of the segments after the first, plus the new ones.
  const newerLive = segs.reduce((n, _s, i) => (i === 0 ? n : n + liveOf(i)), 0) + keyed.length;
  const merge =
    (o.forceMerge ?? false) ||
    liveTotal <= policy.floorDocs ||
    (opened !== null && segs.length + 1 > policy.maxSegments) ||
    (storedTotal > 0 && removedTotal / storedTotal > policy.maxRemovedShare);
  // The newer segments and the change become one segment beside the first.
  const mergeNewer = !merge && segs.length > 1 && newerLive <= policy.floorDocs;

  const embedDocs = async (docs: readonly KeyedDoc[]): Promise<Map<number, PassageVector[]>> => {
    if (!vectorField || !o.embed || !o.vectorModel) return new Map();
    return vectorsFor(docs, vectorField, o.embed, pool, counts);
  };

  const writerFor = async (
    vocabularyFrom: OpenRelease | null,
    segmentsOf: readonly number[] = [],
  ): Promise<SegmentWriter> => {
    const vocabulary = new Map<string, number>();
    if (vocabularyFrom) {
      const from = segmentsOf.map((i) => vocabularyFrom.segments[i]).filter((x) => x !== undefined);
      const buckets = new Set<string>();
      for (const s of from)
        for (const b of Object.keys(s.reader.manifest.vocabulary)) buckets.add(b);
      for (const s of from) {
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
      ...(o.columns ? { columns: o.columns } : {}),
      ...o.tuning,
    });
  };

  /** Writes `old` (live documents with their vectors) and the changed documents, interleaved by key. */
  const writeMerged = async (
    writer: SegmentWriter,
    old: readonly { doc: KeyedDoc; vectors?: (EncodedVector | null)[] }[],
  ): Promise<ReleaseSegment> => {
    const fresh = await embedDocs(keyed);
    let pi = 0;
    let oi = 0;
    while (oi < old.length || pi < keyed.length) {
      const o1 = old[oi];
      const p1 = keyed[pi];
      if (p1 && (!o1 || p1.key < o1.doc.key)) {
        writer.add(p1, fresh.get(p1.key));
        pi++;
      } else if (o1) {
        writer.add(o1.doc, o1.vectors);
        oi++;
      }
    }
    const written = writer.finish();
    return {
      manifest: written.manifestFile,
      removed: null,
      docCount: written.manifest.docCount,
      removedCount: 0,
    };
  };

  /** Segment `i` of the previous release as it stays, with its new removed set. */
  const kept = (i: number): ReleaseSegment => {
    const r = removed[i] as Set<number>;
    const file = r.size > 0 ? contentName("r", encodeKeys(r), "bin") : null;
    if (file) sink(file, encodeKeys(r));
    return {
      manifest: (previous as ReleaseManifest).segments[i]?.manifest as string,
      removed: file,
      docCount: segs[i]?.reader.manifest.docCount ?? 0,
      removedCount: r.size,
    };
  };

  const segments: ReleaseSegment[] = [];
  if (merge) {
    // Old documents and changed ones interleave in key order; a changed key's old copy is in a removed set.
    const all = segs.map((_s, i) => i);
    const old = opened ? await liveDocsInKeyOrder(opened, removed, all) : [];
    segments.push(await writeMerged(await writerFor(null), old));
  } else if (mergeNewer && opened) {
    segments.push(kept(0));
    const newer = segs.map((_s, i) => i).slice(1);
    const old = await liveDocsInKeyOrder(opened, removed, newer);
    segments.push(await writeMerged(await writerFor(opened, [0]), old));
  } else {
    segs.forEach((_s, i) => {
      segments.push(kept(i));
    });
    if (keyed.length > 0) {
      const writer = await writerFor(
        opened,
        segs.map((_s, i) => i),
      );
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
    format: RELEASE_FORMAT as 2,
    schemaDigest: digest,
    segments,
    nextKey,
    docCount: segments.reduce((n, s) => n + s.docCount - s.removedCount, 0),
    vectorModel:
      vectorField && o.vectorModel ? { id: o.vectorModel.id, dims: o.vectorModel.dims } : null,
    profile: o.profile === undefined ? (previous?.profile ?? null) : writeProfile(o.profile, sink),
    columns: [...(o.columns ?? [])],
  };
  const data = utf8.encode(JSON.stringify(manifest));
  const file = contentName("release", data, "json");
  sink(file, data);
  return { manifest, file, merged: merge || mergeNewer, bytesWritten, passages: counts };
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
    ...(o.columns ? { columns: o.columns } : {}),
    ...o.tuning,
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
    format: RELEASE_FORMAT as 2,
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
    columns: [...(o.columns ?? [])],
  };
  const data = utf8.encode(JSON.stringify(manifest));
  const file = contentName("release", data, "json");
  sink(file, data);
  return { manifest, file, merged: true, bytesWritten, passages: counts };
}

/** The live documents of segments `which` with their stored vectors, ascending by key. */
async function liveDocsInKeyOrder(
  opened: OpenRelease,
  removed: readonly ReadonlySet<number>[],
  which: readonly number[],
): Promise<{ doc: KeyedDoc; vectors?: (EncodedVector | null)[] }[]> {
  const out: { doc: KeyedDoc; vectors?: (EncodedVector | null)[] }[] = [];
  for (const si of which) {
    const seg = opened.segments[si] as OpenRelease["segments"][number];
    const gone = removed[si] as ReadonlySet<number>;
    const vectors = await seg.reader.vectorsOf(null);
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
  return cache.get(release.profile, PROFILE_FORMAT);
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
    const m = await cache.get(s.manifest, SEGMENT_MANIFEST_FORMAT);
    // A packed segment's parts live only inside its pack.
    if (m.pack) {
      files.add(m.pack.file);
      continue;
    }
    files.add(m.docsFile);
    for (const x of m.shards) files.add(x.file);
    for (const x of m.stores) files.add(x.file);
    for (const x of Object.values(m.vocabulary)) files.add(x);
    for (const x of m.vectors?.codes ?? []) files.add(x);
    for (const x of m.vectors?.blocks ?? []) files.add(x);
    if (m.vectors?.partitions) {
      files.add(m.vectors.partitions.centroids);
      for (const l of m.vectors.partitions.lists) files.add(l.file);
    }
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
