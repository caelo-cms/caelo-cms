// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1644 (R2, issue #1648) — the `collection_index` job's side.
 *
 * It holds no database credential: it asks the admin what to index, reads
 * the change files and the previous release from the staging collection
 * store, writes the new files there, and reports each release (or failure)
 * back. The admin then counts the changes as applied and the projection
 * tells the staging gateway.
 *
 * Changes fold in order: the last version of a document wins, a delete
 * removes it, a full replacement (`replaceAll`) drops everything before it.
 * The release is a delta on the previous one, unless there is none, the
 * schema, the protected terms or the vector model changed, or a full
 * replacement came; then it is rebuilt from the documents (the previous
 * release's stored documents, which are the rebuild source, and the
 * changes).
 *
 * #1650 — semantic search: when the Stage's configuration names a catalog
 * model (`task.vectorModel`) and the search profile turns semantic search
 * on, every new or changed passage is embedded with that model on native
 * ONNX Runtime, and the release records the model's fingerprint (catalog
 * id + graph digest). A release built with another model, or none, is
 * rebuilt rather than extended, because query vectors of one model must
 * never be compared with passage vectors of another.
 *
 * Only text the collection has not embedded yet goes to the model: a
 * changed document keeps its unchanged passages' vectors, and a rebuild
 * under the same model (a new schema, other protected terms, a full
 * replacement) keeps every vector whose text it still has
 * (@caelo-cms/collection-index vector-pool.ts).
 */

import {
  type AppliedRelease,
  addReleaseVectors,
  applyChanges,
  buildRelease,
  type CollectionDoc,
  type CollectionSchema,
  type CollectionStore,
  FileCache,
  keywordTerm,
  locateDocs,
  lookupDocs,
  openRelease,
  parseRelease,
  readProfile,
  scopedStore,
  VectorPool,
} from "@caelo-cms/collection-index";
import type { Embedder } from "@caelo-cms/models";
import {
  collectionStoreFromEnv,
  decodeChangeFile,
  STAGING_COLLECTION_STORE_ENV,
} from "@caelo-cms/plugin-host";
import type { SearchProfile } from "@caelo-cms/plugin-sdk";
import { type EmbeddingModel, embeddingModel } from "@caelo-cms/shared";
import {
  type JobReporter,
  JobStoppedError,
  SINGLE_TASK,
  type TaskSlot,
} from "../reporting-jobs/job-reporter.js";
import { JOB_TIMING } from "../reporting-jobs/protocol.js";
import {
  collectShards,
  embedShard,
  missingTexts,
  planShards,
  ShardsMissingError,
} from "./index-shards.js";
import type { IndexTask } from "./ops.js";
import { PROGRESS_EVERY_MS } from "./progress.js";

/** Uploads with a bounded number in flight; `drain` waits for all of them. */
class Uploader {
  private inFlight = 0;
  private readonly queue: (() => Promise<void>)[] = [];
  private readonly done: Promise<void>[] = [];
  private failure: unknown = null;
  bytes = 0;

  constructor(
    private readonly store: CollectionStore,
    private readonly limit = 16,
  ) {}

  put(name: string, data: Uint8Array): void {
    this.bytes += data.length;
    this.queue.push(() => this.store.write(name, data, { immutable: true }));
    this.pump();
  }

  private pump(): void {
    while (this.inFlight < this.limit && this.queue.length > 0) {
      const task = this.queue.shift() as () => Promise<void>;
      this.inFlight++;
      this.done.push(
        task()
          .catch((e) => {
            this.failure ??= e;
          })
          .finally(() => {
            this.inFlight--;
            this.pump();
          }),
      );
    }
  }

  async drain(): Promise<void> {
    while (this.queue.length > 0 || this.inFlight > 0) await Promise.all(this.done.splice(0));
    if (this.failure) throw this.failure;
  }
}

/** The changes of a run folded into one batch. */
export interface FoldedChanges {
  readonly reset: boolean;
  readonly upserts: Map<string, CollectionDoc>;
  readonly deletes: Set<string>;
  /**
   * Keyword terms whose documents in the previous release are removed
   * (#1651 `replace`): every document upserted before the removal was
   * dropped from `upserts` already; the ones after it stay.
   */
  readonly deleteWhere: readonly { readonly field: string; readonly value: string }[];
  readonly profile: SearchProfile | undefined;
}

/** Whether `doc`'s keyword `field` holds `value`. */
function holds(doc: CollectionDoc, field: string, value: string): boolean {
  const v = doc.values[field];
  return Array.isArray(v) ? v.includes(value) : v === value;
}

/** Folds change files in order. */
export async function foldChanges(
  store: CollectionStore,
  keys: readonly string[],
): Promise<FoldedChanges> {
  let reset = false;
  const upserts = new Map<string, CollectionDoc>();
  const deletes = new Set<string>();
  const deleteWhere = new Map<string, { field: string; value: string }>();
  let profile: SearchProfile | undefined;
  for (const key of keys) {
    const change = decodeChangeFile(await store.read(key));
    if (change.replaceAll) {
      reset = true;
      upserts.clear();
      deletes.clear();
      deleteWhere.clear();
    }
    for (const w of change.deleteWhere ?? []) {
      for (const value of w.values) {
        deleteWhere.set(`${w.field}\u0000${value}`, { field: w.field, value });
        for (const [id, d] of upserts) if (holds(d, w.field, value)) upserts.delete(id);
      }
    }
    for (const d of change.upserts) {
      upserts.set(d.id, d as CollectionDoc);
      deletes.delete(d.id);
    }
    for (const id of change.deletes) {
      upserts.delete(id);
      deletes.add(id);
    }
    if (change.profile) profile = change.profile;
  }
  return { reset, upserts, deletes, deleteWhere: [...deleteWhere.values()], profile };
}

function onlyDeclared(
  doc: CollectionDoc,
  fields: Readonly<Record<string, unknown>>,
): CollectionDoc {
  return {
    id: doc.id,
    lang: doc.lang,
    values: Object.fromEntries(Object.entries(doc.values).filter(([k]) => k in fields)),
  };
}

function protectedTermsOf(profile: SearchProfile | null | undefined): Set<string> {
  return new Set((profile?.protectedTerms ?? []).map((t) => t.normalize("NFKC").toLowerCase()));
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

/** Gives the job an embedder per catalog model (native ONNX Runtime; tests pass their own). */
export type EmbedderSource = (model: EmbeddingModel) => Promise<Embedder>;

/**
 * Native embedders, one per model, created on first use and released by
 * {@link releaseEmbedders}. The import is lazy: an admin that never indexes
 * with a model never loads ONNX Runtime.
 */
export function nativeEmbedders(): {
  source: EmbedderSource;
  releaseEmbedders: () => Promise<void>;
} {
  const made = new Map<string, Promise<Embedder>>();
  return {
    source: (model) => {
      let e = made.get(model.id);
      if (!e) {
        e = import("@caelo-cms/models/native").then((m) => m.createNativeEmbedder(model));
        made.set(model.id, e);
      }
      return e;
    },
    releaseEmbedders: async () => {
      for (const e of made.values()) await (await e.catch(() => null))?.release();
      made.clear();
    },
  };
}

/** The schema's vector field (the one passages field with `vector: true`), or null. */
function vectorFieldOf(schema: CollectionSchema): string | null {
  const found = Object.entries(schema.fields).find(
    ([, f]) => f.kind === "passages" && f.vector === true,
  );
  return found ? found[0] : null;
}

/** The vector model of a task, or null when it builds no vectors. */
function vectorModelOf(
  task: IndexTask,
  schema: CollectionSchema,
  profile: SearchProfile | undefined,
): EmbeddingModel | null {
  const hasVectorField = Object.values(schema.fields).some(
    (f) => f.kind === "passages" && f.vector === true,
  );
  if (!hasVectorField || task.vectorModel === null || !profile?.semantic) return null;
  const model = embeddingModel(task.vectorModel);
  if (!model) {
    throw new Error(
      `the Stage named the embedding model ${task.vectorModel}, which this release's catalog does not have: pick a model in Settings → Plugin settings and Stage again`,
    );
  }
  return model;
}

/**
 * Passages one task embeds before the build asks for more tasks. A 2-vCPU
 * Cloud Run task embedded searchviu.com's passages (648 characters on
 * average) at 6 to 19 a second (2026-11-26: the host decides), so a share
 * takes 5 to 17 minutes.
 */
export const PASSAGES_PER_TASK = 6_000;

/** What one task of an attempt did with one collection. */
export type CollectionOutcome =
  | {
      readonly kind: "built";
      readonly applied: AppliedRelease;
      readonly stats: Record<string, unknown>;
    }
  /** A task other than the first embedded its share; the first builds. */
  | { readonly kind: "shared" }
  /** Too much to embed for one task: the next attempt should run this many. */
  | { readonly kind: "scale"; readonly tasks: number; readonly reason: string };

/** How {@link indexCollection} runs: alone or as one task of a wide attempt. */
export interface IndexOptions {
  readonly embedders?: EmbedderSource;
  readonly slot?: TaskSlot;
  /**
   * This task's embedding progress: once when it starts, at most every
   * {@link PROGRESS_EVERY_MS} after, and once at the end. `planned` is what
   * the whole attempt embeds for the collection, so tasks that have not
   * reported yet still count.
   */
  readonly onProgress?: (p: {
    readonly embedded: number;
    readonly toEmbed: number;
    readonly planned: number;
  }) => Promise<void>;
  /** When the first task of a wide attempt stops waiting for the others (epoch ms). */
  readonly shardDeadline?: number;
  /** Between looks for the other tasks' vectors (tests shorten it). */
  readonly pollMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Calls `report` for the first count, then at most every {@link PROGRESS_EVERY_MS}, and always for the last. */
function throttled(
  report: IndexOptions["onProgress"],
  toEmbed: number,
  planned: number,
  now: () => number,
): (embedded: number) => Promise<void> {
  let last = Number.NEGATIVE_INFINITY;
  return async (embedded) => {
    if (!report) return;
    if (embedded < toEmbed && now() - last < PROGRESS_EVERY_MS) return;
    last = now();
    await report({ embedded, toEmbed, planned });
  };
}

/**
 * Builds one collection's next release in `store`, or, as a task of a wide
 * attempt, embeds this task's share of it (index-shards.ts).
 */
export async function indexCollection(
  store: CollectionStore,
  task: IndexTask,
  opts: IndexOptions = {},
): Promise<CollectionOutcome> {
  const slot = opts.slot ?? SINGLE_TASK;
  const now = opts.now ?? Date.now;
  const embedders = opts.embedders ?? nativeEmbedders().source;
  const scoped = scopedStore(store, `${task.slug}/${task.collection}`);
  const cache = new FileCache({ read: (f) => scoped.read(f) }, 512 * 1024 * 1024);
  const folded = await foldChanges(store, task.changeKeys);
  const previous = task.previousReleaseKey
    ? parseRelease(await scoped.read(task.previousReleaseKey))
    : null;
  const previousProfile = previous
    ? ((await readProfile(previous, cache)) as SearchProfile | null)
    : null;
  const profile = folded.profile ?? previousProfile ?? undefined;
  const protectedTerms = protectedTermsOf(profile);
  const schema: CollectionSchema = { fields: task.fields as CollectionSchema["fields"] };
  const model = vectorModelOf(task, schema, profile);
  const field = vectorFieldOf(schema);
  // A wide attempt's other tasks only embed; a collection without vectors is the first task's.
  if (slot.index > 0 && (!model || !field)) return { kind: "shared" };
  const embedder = model ? await embedders(model) : null;
  const rebuild =
    previous === null ||
    folded.reset ||
    task.previousSchemaDigest !== task.schemaDigest ||
    !sameSet(protectedTermsOf(previousProfile), protectedTerms) ||
    (previous.vectorModel?.id ?? null) !== (embedder?.fingerprint ?? null);

  // The vectors this build may keep: the previous release's, under the same model.
  const pool = new VectorPool();
  const opened =
    previous && (!rebuild || !folded.reset) ? await openRelease(previous, cache) : null;
  const sameModel =
    previous !== null && embedder !== null && previous.vectorModel?.id === embedder.fingerprint;
  if (sameModel && field) {
    const base = opened ?? (await openRelease(previous as NonNullable<typeof previous>, cache));
    if (rebuild) {
      await addReleaseVectors(pool, base, field);
    } else {
      const at = await locateDocs(base, [...folded.upserts.keys()]);
      const keys = new Map<number, Set<number>>();
      for (const { segment, key } of at.values())
        (keys.get(segment) ?? keys.set(segment, new Set()).get(segment))?.add(key);
      await addReleaseVectors(pool, base, field, keys);
    }
  }
  const docs = async function* (): AsyncGenerator<CollectionDoc> {
    if (opened && rebuild) {
      for (const seg of opened.segments) {
        for await (const doc of seg.reader.allStored()) {
          if (
            seg.removed.has(doc.key) ||
            folded.upserts.has(doc.id) ||
            folded.deletes.has(doc.id) ||
            folded.deleteWhere.some((w) => holds(doc, w.field, w.value))
          )
            continue;
          yield onlyDeclared(doc, task.fields);
        }
      }
    }
    yield* folded.upserts.values();
  };
  const missing =
    embedder && field ? await missingTexts(docs(), field, pool) : new Map<string, string>();
  const toEmbed = missing.size;

  if (embedder && toEmbed > 0) {
    // Too much for this attempt's tasks, alone or already wide (a later
    // collection of the run can need more than the one that widened it).
    const tasks = Math.min(slot.max, Math.ceil(toEmbed / PASSAGES_PER_TASK));
    if (tasks > slot.count) {
      return {
        kind: "scale",
        tasks,
        reason: `${toEmbed.toLocaleString("en-US")} passages of ${task.slug}/${task.collection} to embed: ${tasks} tasks`,
      };
    }
    if (slot.count > 1) {
      const plan = planShards(embedder.fingerprint, missing, slot.count);
      const share = plan.share(slot.index);
      await embedShard(
        scoped,
        plan.names[slot.index] as string,
        share,
        embedder,
        throttled(opts.onProgress, share.length, toEmbed, now),
      );
      if (slot.index > 0) return { kind: "shared" };
      await collectShards(scoped, plan, embedder.model.dims, pool, {
        deadline: opts.shardDeadline ?? now() + 50 * 60_000,
        pollMs: opts.pollMs ?? 10_000,
        now,
        sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      });
    }
  }

  // Only the first task builds and reports, also when nothing was left to embed.
  if (slot.index > 0) return { kind: "shared" };

  const uploader = new Uploader(scoped);
  const sink = (name: string, data: Uint8Array): void => uploader.put(name, data);
  // Alone, the build embeds what is missing; in a wide attempt the shards held it all.
  const inline = slot.count === 1 ? toEmbed : 0;
  const progress = throttled(opts.onProgress, inline, inline, now);
  if (inline > 0) await progress(0);
  let embedded = 0;
  let embedMs = 0;
  const vectors = embedder
    ? {
        vectorModel: { id: embedder.fingerprint, dims: embedder.model.dims },
        embed: async (texts: readonly string[]) => {
          const t = performance.now();
          const out = await embedder.embed(texts, "passage");
          embedMs += performance.now() - t;
          embedded += texts.length;
          await progress(embedded);
          return out;
        },
      }
    : {};
  let applied: AppliedRelease;
  if (rebuild) {
    applied = await buildRelease(docs(), {
      schema,
      sink,
      protectedTerms,
      profile,
      reuse: pool,
      ...vectors,
    });
  } else {
    // Documents of the previous release a `replace` removed, by their terms.
    if (folded.deleteWhere.length > 0 && opened) {
      for (const d of await lookupDocs(
        opened,
        folded.deleteWhere.map((w) => keywordTerm(w.field, w.value)),
      ))
        if (!folded.upserts.has(d.id)) folded.deletes.add(d.id);
    }
    applied = await applyChanges(
      previous,
      { upserts: [...folded.upserts.values()], deletes: [...folded.deletes] },
      {
        schema,
        sink,
        cache,
        protectedTerms,
        reuse: pool,
        ...vectors,
        ...(folded.profile ? { profile: folded.profile } : {}),
      },
    );
  }
  if (applied.manifest.docCount > task.maxDocuments) {
    throw new Error(
      `the collection would hold ${applied.manifest.docCount} documents; it declares at most ${task.maxDocuments}`,
    );
  }
  await uploader.drain();
  const stats = {
    schemaDigest: task.schemaDigest,
    docCount: applied.manifest.docCount,
    segments: applied.manifest.segments.length,
    bytesWritten: uploader.bytes,
    rebuilt: rebuild,
    merged: applied.merged,
    changes: task.changeKeys.length,
    vectorModel: embedder?.fingerprint ?? null,
    passagesEmbedded: slot.count > 1 ? toEmbed : embedded,
    passagesReused: applied.passages.reused - (slot.count > 1 ? toEmbed : 0),
    embedSeconds: Math.round(embedMs / 100) / 10,
    tasks: slot.count,
  };
  return { kind: "built", applied, stats };
}

/** The job's main: every pending collection of the run, one after the other. */
export async function runCollectionIndexJob(reporter: JobReporter): Promise<void> {
  const startedAt = Date.now();
  const { tasks } = (await reporter.call("tasks", {})) as { tasks: IndexTask[] };
  if (tasks.length === 0) return;
  const store = collectionStoreFromEnv(STAGING_COLLECTION_STORE_ENV);
  const embedders = nativeEmbedders();
  try {
    await indexTasks(reporter, store, tasks, {
      embedders: embedders.source,
      slot: reporter.slot ?? SINGLE_TASK,
      // The first task stops waiting five minutes before the attempt's limit.
      shardDeadline: startedAt + (JOB_TIMING.collection_index.maxRunSeconds - 300) * 1000,
    });
  } finally {
    // In-process (self-hosted) the admin keeps running: give the model's memory back.
    await embedders.releaseEmbedders();
  }
}

/** Every pending collection, reported as the slot's part: the first task reports, the others embed. */
export async function indexTasks(
  reporter: JobReporter,
  store: CollectionStore,
  tasks: readonly IndexTask[],
  opts: IndexOptions,
): Promise<void> {
  const slot = opts.slot ?? SINGLE_TASK;
  for (const task of tasks) {
    const target = { pluginId: task.pluginId, collection: task.collection };
    let outcome: CollectionOutcome;
    try {
      outcome = await indexCollection(store, task, {
        ...opts,
        // A count the admin missed is no reason to stop indexing.
        onProgress: async ({ embedded, toEmbed, planned }) => {
          try {
            await reporter.call("progress", {
              ...target,
              task: slot.index,
              tasks: slot.count,
              embedded,
              toEmbed,
              planned,
            });
          } catch (e) {
            if (e instanceof JobStoppedError) throw e;
            console.error(
              `[collection-index] ${task.slug}/${task.collection}: progress not recorded:`,
              e instanceof Error ? e.message : e,
            );
          }
        },
      });
    } catch (e) {
      // Only the first task reports for the attempt. A task that is not, or
      // missing shards, end the attempt: the next one starts over and keeps
      // every shard that was written.
      if (slot.index > 0 || e instanceof ShardsMissingError || e instanceof JobStoppedError)
        throw e;
      const error = e instanceof Error ? e.message : String(e);
      await reporter.call("failed", { ...target, error: error.slice(0, 4000) });
      continue;
    }
    if (outcome.kind === "scale") {
      // The admin ends this attempt and starts one that runs this many
      // tasks. Every task of a wide attempt planned the same; the first asks.
      if (slot.index === 0) {
        await reporter.call("scale", { tasks: outcome.tasks, reason: outcome.reason });
      }
      return;
    }
    if (outcome.kind === "built") {
      await reporter.call("done", {
        ...target,
        releaseKey: outcome.applied.file,
        stats: outcome.stats,
      });
    }
  }
}
