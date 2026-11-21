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
 */

import {
  type AppliedRelease,
  applyChanges,
  buildRelease,
  type CollectionDoc,
  type CollectionSchema,
  type CollectionStore,
  FileCache,
  openRelease,
  parseRelease,
  readProfile,
  scopedStore,
} from "@caelo-cms/collection-index";
import type { Embedder } from "@caelo-cms/models";
import {
  collectionStoreFromEnv,
  decodeChangeFile,
  STAGING_COLLECTION_STORE_ENV,
} from "@caelo-cms/plugin-host";
import type { SearchProfile } from "@caelo-cms/plugin-sdk";
import { type EmbeddingModel, embeddingModel } from "@caelo-cms/shared";
import type { JobReporter } from "../reporting-jobs/job-reporter.js";
import type { IndexTask } from "./ops.js";

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
  readonly profile: SearchProfile | undefined;
}

/** Folds change files in order. */
export async function foldChanges(
  store: CollectionStore,
  keys: readonly string[],
): Promise<FoldedChanges> {
  let reset = false;
  const upserts = new Map<string, CollectionDoc>();
  const deletes = new Set<string>();
  let profile: SearchProfile | undefined;
  for (const key of keys) {
    const change = decodeChangeFile(await store.read(key));
    if (change.replaceAll) {
      reset = true;
      upserts.clear();
      deletes.clear();
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
  return { reset, upserts, deletes, profile };
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

/** Builds one collection's next release in `store`; returns it with its statistics. */
export async function indexCollection(
  store: CollectionStore,
  task: IndexTask,
  embedders: EmbedderSource = nativeEmbedders().source,
): Promise<{ applied: AppliedRelease; stats: Record<string, unknown> }> {
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
  const uploader = new Uploader(scoped);
  const sink = (name: string, data: Uint8Array): void => uploader.put(name, data);
  const model = vectorModelOf(task, schema, profile);
  const embedder = model ? await embedders(model) : null;
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
          return out;
        },
      }
    : {};
  const rebuild =
    previous === null ||
    folded.reset ||
    task.previousSchemaDigest !== task.schemaDigest ||
    !sameSet(protectedTermsOf(previousProfile), protectedTerms) ||
    (previous.vectorModel?.id ?? null) !== (embedder?.fingerprint ?? null);
  let applied: AppliedRelease;
  if (rebuild) {
    const opened = previous && !folded.reset ? await openRelease(previous, cache) : null;
    const docs = async function* (): AsyncGenerator<CollectionDoc> {
      if (opened) {
        for (const seg of opened.segments) {
          for await (const doc of seg.reader.allStored()) {
            if (
              seg.removed.has(doc.key) ||
              folded.upserts.has(doc.id) ||
              folded.deletes.has(doc.id)
            )
              continue;
            yield onlyDeclared(doc, task.fields);
          }
        }
      }
      yield* folded.upserts.values();
    };
    applied = await buildRelease(docs(), { schema, sink, protectedTerms, profile, ...vectors });
  } else {
    applied = await applyChanges(
      previous,
      { upserts: [...folded.upserts.values()], deletes: [...folded.deletes] },
      {
        schema,
        sink,
        cache,
        protectedTerms,
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
    passagesEmbedded: embedded,
    embedSeconds: Math.round(embedMs / 100) / 10,
  };
  return { applied, stats };
}

/** The job's main: every pending collection of the run, one after the other. */
export async function runCollectionIndexJob(reporter: JobReporter): Promise<void> {
  const { tasks } = (await reporter.call("tasks", {})) as { tasks: IndexTask[] };
  if (tasks.length === 0) return;
  const store = collectionStoreFromEnv(STAGING_COLLECTION_STORE_ENV);
  const embedders = nativeEmbedders();
  try {
    await indexTasks(reporter, store, tasks, embedders.source);
  } finally {
    // In-process (self-hosted) the admin keeps running: give the model's memory back.
    await embedders.releaseEmbedders();
  }
}

async function indexTasks(
  reporter: JobReporter,
  store: CollectionStore,
  tasks: readonly IndexTask[],
  embedders: EmbedderSource,
): Promise<void> {
  for (const task of tasks) {
    try {
      const { applied, stats } = await indexCollection(store, task, embedders);
      await reporter.call("done", {
        pluginId: task.pluginId,
        collection: task.collection,
        releaseKey: applied.file,
        stats,
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      await reporter.call("failed", {
        pluginId: task.pluginId,
        collection: task.collection,
        error: error.slice(0, 4000),
      });
    }
  }
}
