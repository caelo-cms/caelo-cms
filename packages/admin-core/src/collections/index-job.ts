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
  readQueryVectors,
  releaseNeedsRebuild,
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
import type { PieceClaim } from "../ops/job_pieces.js";
import {
  type JobReporter,
  JobStoppedError,
  SINGLE_TASK,
  type TaskSlot,
  workerOf,
} from "../reporting-jobs/job-reporter.js";
import { JOB_TIMING, MAX_JOB_TASKS } from "../reporting-jobs/protocol.js";
import {
  collectShards,
  embedShard,
  missingTexts,
  planShards,
  SHARD_PASSAGES,
  ShardsMissingError,
  writtenShards,
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
 * Passages one task embeds before the build wants another. A 2-vCPU Cloud
 * Run task embedded searchviu.com's passages (648 characters on average) at
 * 6 to 19 a second (2026-11-26: the host decides), so a share takes 5 to 17
 * minutes; a helper that joins for less would spend more on planning the
 * build than it saves.
 */
export const PASSAGES_PER_TASK = 6_000;

/** How long a claimed shard is a task's: a shard takes up to about six minutes. */
const SHARD_CLAIM_SECONDS = 15 * 60;

/** What one task did with one collection. */
export type CollectionOutcome =
  | {
      readonly kind: "built";
      readonly applied: AppliedRelease;
      readonly stats: Record<string, unknown>;
    }
  /** A helper embedded shards; the lead builds. */
  | { readonly kind: "shared" };

/** A helper heard `stop`: a job of a higher class needs its CPU (#1776). */
export class HelperStoppedError extends Error {
  constructor() {
    super(
      "the capacity ledger stopped this helper after its shard: a job of a higher class needs the CPU",
    );
    this.name = "HelperStoppedError";
  }
}

/** How a task takes shards of one collection: the admin's claims (#1776, ops/job_pieces.ts). */
export interface ShardClaims {
  /** The lead names the build's shards, which of them exist, and how wide it would run. */
  register(count: number, done: readonly number[], wantedTasks: number): Promise<void>;
  claim(): Promise<PieceClaim>;
  done(shard: number): Promise<void>;
}

/** How {@link indexCollection} runs: as the attempt's lead or as a helper's task. */
export interface IndexOptions {
  readonly embedders?: EmbedderSource;
  readonly slot?: TaskSlot;
  /**
   * This task's embedding progress: once when it starts, at most every
   * {@link PROGRESS_EVERY_MS} after, and once at the end. `embedded` is
   * this task's (the lead's includes the shards earlier attempts wrote);
   * `planned` is what the whole build embeds.
   */
  readonly onProgress?: (p: {
    readonly embedded: number;
    readonly planned: number;
    /** The tasks the build would run on, the lead included. */
    readonly wantedTasks: number;
  }) => Promise<void>;
  /** The claims of a collection's shards; required for a build in shards. */
  readonly claims?: (task: IndexTask) => ShardClaims;
  /**
   * The end of this task's time for shards (epoch ms): no shard is claimed
   * in its last ten minutes.
   */
  readonly shardDeadline?: number;
  /** Between two claims while every open shard is taken (tests shorten it). */
  readonly pollMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Calls `report` for the first count, then at most every {@link PROGRESS_EVERY_MS}, and always for the last. */
function throttled(
  report: IndexOptions["onProgress"],
  planned: number,
  wantedTasks: number,
  now: () => number,
): (embedded: number, last?: boolean) => Promise<void> {
  let at = Number.NEGATIVE_INFINITY;
  return async (embedded, last = false) => {
    if (!report) return;
    if (!last && now() - at < PROGRESS_EVERY_MS) return;
    at = now();
    await report({ embedded, planned, wantedTasks });
  };
}

/** Most known queries one release embeds (#1785). */
export const MAX_KNOWN_QUERIES = 2000;

/**
 * The query texts a profile names, once each, in a stable order: its known
 * queries, its suggestions and its pinned results' queries, every language.
 */
export function knownQueriesOf(profile: SearchProfile | null): string[] {
  if (!profile) return [];
  const out = new Set<string>();
  const add = (t: string): void => {
    const q = t.trim();
    if (q.length > 0 && out.size < MAX_KNOWN_QUERIES) out.add(q);
  };
  for (const list of Object.values(profile.knownQueries ?? {})) for (const t of list) add(t);
  for (const list of Object.values(profile.suggestions ?? {})) for (const s of list) add(s.text);
  for (const list of Object.values(profile.bestBets ?? {})) for (const b of list) add(b.query);
  return [...out].sort();
}

/**
 * Builds one collection's next release in `store` (the lead), or embeds
 * shards of it (a helper's task, index-shards.ts).
 */
export async function indexCollection(
  store: CollectionStore,
  task: IndexTask,
  opts: IndexOptions = {},
): Promise<CollectionOutcome> {
  const slot = opts.slot ?? SINGLE_TASK;
  const helper = slot.helper !== null;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
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
  // A helper only embeds; a collection without vectors is the lead's alone.
  if (helper && (!model || !field)) return { kind: "shared" };
  const embedder = model ? await embedders(model) : null;
  const rebuild =
    previous === null ||
    folded.reset ||
    task.previousSchemaDigest !== task.schemaDigest ||
    !sameSet(protectedTermsOf(previousProfile), protectedTerms) ||
    (previous.vectorModel?.id ?? null) !== (embedder?.fingerprint ?? null) ||
    // #1780 — an older engine format or other keyword columns: never extended.
    releaseNeedsRebuild(previous, task.columns);

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

  // More than one shard: embedded in shard files, which survive a retry,
  // by as many tasks as the capacity ledger grants.
  const plan =
    embedder && toEmbed > SHARD_PASSAGES ? planShards(embedder.fingerprint, missing) : null;
  const wanted = Math.min(
    MAX_JOB_TASKS,
    Math.ceil(toEmbed / PASSAGES_PER_TASK),
    plan?.names.length ?? 1,
  );
  if (helper && !plan) return { kind: "shared" };
  if (plan && embedder) {
    if (!opts.claims) throw new Error("a build in shards needs the admin's claims");
    const claims = opts.claims(task);
    let base = 0;
    if (!helper) {
      const done = await writtenShards(scoped, plan);
      base = done.reduce((n, i) => n + plan.texts(i).length, 0);
      await claims.register(plan.names.length, done, wanted);
    }
    const progress = throttled(opts.onProgress, toEmbed, wanted, now);
    await progress(base);
    // A shard takes a few minutes: none is claimed in the task's last ten.
    const deadline = opts.shardDeadline ?? now() + 50 * 60_000;
    let embedded = base;
    for (;;) {
      if (now() >= deadline - 10 * 60_000) {
        await progress(embedded, true);
        if (helper) return { kind: "shared" };
        const written = await writtenShards(scoped, plan);
        throw new ShardsMissingError(plan.names.length - written.length, plan.names.length);
      }
      const c = await claims.claim();
      if ("stop" in c) {
        await progress(embedded, true);
        throw new HelperStoppedError();
      }
      if ("none" in c) break;
      if ("wait" in c) {
        // Others still embed their shards. A helper moves on; the lead
        // waits, and takes over a shard whose claim runs out.
        if (helper) break;
        await sleep(opts.pollMs ?? 10_000);
        continue;
      }
      const before = embedded;
      embedded += await embedShard(scoped, plan, c.piece, embedder, (inShard) =>
        progress(before + inShard),
      );
      await claims.done(c.piece);
    }
    await progress(embedded, true);
    if (helper) return { kind: "shared" };
    await collectShards(scoped, plan, embedder.model.dims, pool);
  }

  // Only the lead builds and reports, also when nothing was left to embed.
  if (helper) return { kind: "shared" };

  const uploader = new Uploader(scoped);
  const sink = (name: string, data: Uint8Array): void => uploader.put(name, data);
  // A small build embeds what is missing as it goes; a sharded one has it all in the pool.
  const inline = plan ? 0 : toEmbed;
  const progress = throttled(opts.onProgress, inline, wanted, now);
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
          await progress(embedded, embedded >= inline);
          return out;
        },
      }
    : {};
  // #1785 — the queries the profile names, embedded as queries: the
  // gateway answers them without its query model. Vectors the previous
  // release holds for the same model are kept, never embedded again.
  const queryVectors = new Map<string, Float32Array>();
  if (embedder) {
    const known = knownQueriesOf(profile ?? null);
    const before =
      previous && previous.vectorModel?.id === embedder.fingerprint
        ? await readQueryVectors(previous, cache)
        : new Map<string, Float32Array>();
    const missingQueries = known.filter((t) => !before.has(t));
    const fresh = missingQueries.length > 0 ? await embedder.embed(missingQueries, "query") : [];
    for (const t of known) {
      const v = before.get(t) ?? fresh[missingQueries.indexOf(t)];
      if (v) queryVectors.set(t, v);
    }
  }
  let applied: AppliedRelease;
  if (rebuild) {
    applied = await buildRelease(docs(), {
      queryVectors,
      schema,
      sink,
      protectedTerms,
      profile,
      reuse: pool,
      columns: task.columns,
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
        columns: task.columns,
        queryVectors,
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
    // A sharded build's texts came into the pool from the shards.
    passagesEmbedded: plan ? toEmbed : embedded,
    passagesReused: applied.passages.reused - (plan ? toEmbed : 0),
    embedSeconds: Math.round(embedMs / 100) / 10,
  };
  return { kind: "built", applied, stats };
}

/** The job's main: every pending collection of the run, one after the other. */
export async function runCollectionIndexJob(reporter: JobReporter): Promise<void> {
  const startedAt = Date.now();
  const slot = reporter.slot ?? SINGLE_TASK;
  const { tasks } = (await reporter.call("tasks", {})) as { tasks: IndexTask[] };
  if (tasks.length === 0) return;
  // A helper works only where shards are open; it plans nothing else.
  let mine = tasks;
  if (slot.helper !== null) {
    const { scopes } = (await reporter.call("open-scopes", {})) as { scopes: string[] };
    mine = tasks.filter((t) => scopes.includes(shardScope(t)));
  }
  const store = collectionStoreFromEnv(STAGING_COLLECTION_STORE_ENV);
  const embedders = nativeEmbedders();
  try {
    await indexTasks(reporter, store, mine, {
      embedders: embedders.source,
      slot,
      // No shard is claimed in the last ten minutes before the execution's limit.
      shardDeadline: startedAt + (JOB_TIMING.collection_index.maxRunSeconds - 300) * 1000,
    });
  } finally {
    // In-process (self-hosted) the admin keeps running: give the model's memory back.
    await embedders.releaseEmbedders();
  }
}

/** The pieces scope of a collection's shards (index-job-kind.ts reads it back). */
export function shardScope(task: Pick<IndexTask, "pluginId" | "collection">): string {
  return `${task.pluginId}/${task.collection}`;
}

/** The admin's claims of one collection's shards, through `reporter`. */
export function reporterClaims(reporter: JobReporter, task: IndexTask): ShardClaims {
  const target = { pluginId: task.pluginId, collection: task.collection };
  const worker = workerOf(reporter.slot ?? SINGLE_TASK);
  return {
    register: async (count, done, wantedTasks) => {
      await reporter.call("pieces", { ...target, count, done: [...done], wantedTasks });
    },
    claim: () =>
      reporter.call<PieceClaim>("claim", { ...target, worker, claimSeconds: SHARD_CLAIM_SECONDS }),
    done: async (shard) => {
      await reporter.call("piece-done", { ...target, piece: shard });
    },
  };
}

/**
 * Every collection of `tasks`, as the slot's part: the lead builds and
 * reports each, a helper's task embeds shards and leaves when none is left
 * for it.
 */
export async function indexTasks(
  reporter: JobReporter,
  store: CollectionStore,
  tasks: readonly IndexTask[],
  opts: IndexOptions,
): Promise<void> {
  const slot = opts.slot ?? SINGLE_TASK;
  const helper = slot.helper !== null;
  for (const task of tasks) {
    const target = { pluginId: task.pluginId, collection: task.collection };
    let outcome: CollectionOutcome;
    try {
      outcome = await indexCollection(store, task, {
        ...opts,
        claims: opts.claims ?? ((t) => reporterClaims(reporter, t)),
        // A count the admin missed is no reason to stop indexing.
        onProgress: async ({ embedded, planned, wantedTasks }) => {
          try {
            await reporter.call("progress", {
              ...target,
              worker: workerOf(slot),
              embedded,
              planned,
              wantedTasks,
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
      // A helper that was stopped gave its task back with the claim; any
      // other failure of a helper ends only it (its shard's claim runs
      // out). Only the lead reports for the attempt, and missing shards
      // end the attempt: the next one keeps every shard that was written.
      if (e instanceof HelperStoppedError) return;
      if (helper && !(e instanceof JobStoppedError)) {
        // Its CPU comes back now rather than when its booking runs out.
        await reporter.call("leave", { worker: workerOf(slot) }).catch(() => undefined);
        throw e;
      }
      if (e instanceof ShardsMissingError || e instanceof JobStoppedError) throw e;
      const error = e instanceof Error ? e.message : String(e);
      await reporter.call("failed", { ...target, error: error.slice(0, 4000) });
      continue;
    }
    if (outcome.kind === "built") {
      await reporter.call("done", {
        ...target,
        releaseKey: outcome.applied.file,
        stats: outcome.stats,
      });
    }
  }
  // A helper's task that ran out of shards gives its CPU back now.
  if (helper) await reporter.call("leave", { worker: workerOf(slot) });
}
