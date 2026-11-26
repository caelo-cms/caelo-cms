// SPDX-License-Identifier: MPL-2.0

/**
 * A large index build in pieces: when a build has more passage text to
 * embed than one shard holds (a first index with semantic search or a
 * model change; about 800,000 passages on a 50,000-page site), it embeds
 * the texts in shard files of {@link SHARD_PASSAGES}, and the attempt may
 * run several tasks (as many as the project's CPU quota leaves, reporting-
 * jobs run-capacity.ts).
 *
 * Every task plans the same build, from the same change files over the
 * same previous release, so they agree on the shards without talking to
 * each other. Task `i` of `n` embeds shards `i`, `i + n`, `i + 2n` …; the
 * first task then waits for every shard, adds them to its pool and builds
 * the release, embedding nothing more.
 *
 * A shard file is named after the model and the texts it holds (a hash
 * bucket of them, {@link planShards}), and a finished one is never embedded
 * again. So an attempt that died or ran out of time leaves its finished
 * shards to the next one, also one with another width, and a later Stage
 * with nearly the same texts to embed keeps most of them: a narrow width (a
 * small quota) only takes longer. The files live
 * under the collection's prefix and go with the clean-up like every file no
 * release names (gc.ts), never while an index job of the collection runs.
 */

import { createHash } from "node:crypto";
import {
  type CollectionDoc,
  type CollectionStore,
  decodeVectorShard,
  type EncodedVector,
  encodeVector,
  encodeVectorShard,
  passageEmbeddingText,
  VectorPool,
} from "@caelo-cms/collection-index";
import type { Embedder } from "@caelo-cms/models";

/** Texts sent to the model per call while a task embeds its share. */
const SHARD_EMBED_BATCH = 32;

/**
 * Texts per shard file: a few minutes of one task (6 to 19 passages a
 * second on 2 vCPU, index-job.ts), so a task that dies loses at most that.
 */
export const SHARD_PASSAGES = 2_000;

/** The attempt ended with shards still missing; the next one embeds only those. */
export class ShardsMissingError extends Error {
  constructor(
    readonly missing: readonly number[],
    readonly total: number,
    readonly tasks: number,
    reason: "time" | "tasks",
  ) {
    const owners = [...new Set(missing.map((s) => s % tasks))].sort((a, b) => a - b);
    super(
      reason === "time"
        ? `${missing.length} of ${total} pieces of the search index were not embedded within this attempt's time; the next attempt embeds only those (the time a large index takes falls with the tasks the project's CPU quota allows)`
        : `${missing.length} of ${total} pieces of the search index, of task(s) ${owners.join(", ")} of ${tasks}, did not arrive within this attempt's time: those tasks ran out of time or stopped (their Cloud Run task logs say which); the next attempt embeds only what is still missing`,
    );
    this.name = "ShardsMissingError";
  }
}

/** The passages of `doc`'s vector field. */
function passagesOf(
  doc: CollectionDoc,
  field: string,
): readonly { heading?: string; text: string }[] {
  const v = doc.values[field];
  return Array.isArray(v) ? (v as { heading?: string; text: string }[]) : [];
}

/**
 * The distinct texts of `docs`' passages that `pool` has no vector for,
 * by pool key: what this build has to embed.
 */
export async function missingTexts(
  docs: AsyncIterable<CollectionDoc> | Iterable<CollectionDoc>,
  field: string,
  pool: VectorPool,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for await (const doc of docs) {
    for (const p of passagesOf(doc, field)) {
      const text = passageEmbeddingText(p as never);
      const key = VectorPool.keyOf(text);
      if (!out.has(key) && !pool.getByKey(key)) out.set(key, text);
    }
  }
  return out;
}

/** How a build splits the texts to embed into shard files. */
export interface ShardPlan {
  /** Store names of the shard files. */
  readonly names: readonly string[];
  /** Shard `shard`'s texts by pool key. */
  texts(shard: number): (readonly [string, string])[];
  /** The shards task `index` of `count` embeds. */
  shardsOf(index: number, count: number): number[];
}

/**
 * Splits `missing` into shards of about {@link SHARD_PASSAGES}, the same way
 * in every task and every attempt of the build.
 *
 * A text's shard is a hash bucket of its key, not a position in the sorted
 * list: one text more or less changes only its own shard, so a later Stage
 * whose index still lacks most of the same texts (a first index that did
 * not finish before the next Stage) finds the other shards already written.
 * The bucket count is the power of two that keeps shards at most
 * {@link SHARD_PASSAGES}; only crossing one renames them all.
 */
export function planShards(fingerprint: string, missing: ReadonlyMap<string, string>): ShardPlan {
  let buckets = 1;
  while (missing.size / buckets > SHARD_PASSAGES) buckets *= 2;
  const byBucket: (readonly [string, string])[][] = Array.from({ length: buckets }, () => []);
  for (const key of [...missing.keys()].sort()) {
    const b = createHash("sha256").update(key).digest().readUInt32BE(0) % buckets;
    byBucket[b]?.push([key, missing.get(key) as string]);
  }
  const used = byBucket
    .map((texts, bucket) => ({ texts, bucket }))
    .filter((s) => s.texts.length > 0);
  const names = used.map(({ texts, bucket }) => {
    const h = createHash("sha256");
    h.update(`${fingerprint}\u0000${buckets}\u0000${bucket}`);
    for (const [k] of texts) h.update(`\u0000${k}`);
    return `vectors/v-${h.digest("hex").slice(0, 32)}.bin`;
  });
  return {
    names,
    texts: (i) => used[i]?.texts ?? [],
    shardsOf: (index, count) => names.map((_, i) => i).filter((i) => i % count === index),
  };
}

/** How a task embeds its shards. */
export interface EmbedShardsOptions {
  /** Cumulative texts of its shards done, finished shards of earlier attempts included. */
  readonly onEmbedded: (embedded: number) => Promise<void>;
  /** True once no new shard may start: the attempt's time is up. */
  readonly timeUp: () => boolean;
}

/**
 * Embeds each of `shards` that no earlier attempt wrote, one file each,
 * and stops starting new ones once `timeUp`.
 *
 * @returns how many texts this call embedded.
 */
export async function embedShards(
  store: CollectionStore,
  plan: ShardPlan,
  shards: readonly number[],
  embedder: Embedder,
  o: EmbedShardsOptions,
): Promise<number> {
  // What earlier attempts (or Stages) left counts from the first report on.
  const todo: number[] = [];
  let done = 0;
  for (const shard of shards) {
    if (await store.has(plan.names[shard] as string)) done += plan.texts(shard).length;
    else todo.push(shard);
  }
  await o.onEmbedded(done);
  let embeddedHere = 0;
  for (const shard of todo) {
    if (o.timeUp()) break;
    const name = plan.names[shard] as string;
    const texts = plan.texts(shard);
    const entries: [string, EncodedVector][] = [];
    for (let i = 0; i < texts.length; i += SHARD_EMBED_BATCH) {
      const batch = texts.slice(i, i + SHARD_EMBED_BATCH);
      const vectors = await embedder.embed(
        batch.map(([, text]) => text),
        "passage",
      );
      batch.forEach(([key], at) => {
        entries.push([key, encodeVector(vectors[at] as Float32Array)]);
      });
      await o.onEmbedded(done + entries.length);
    }
    await store.write(name, encodeVectorShard(entries, embedder.model.dims), { immutable: true });
    done += entries.length;
    embeddedHere += entries.length;
  }
  return embeddedHere;
}

/** How the first task waits for the others. */
export interface CollectOptions {
  /** When it stops waiting (epoch ms). */
  readonly deadline: number;
  readonly pollMs: number;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

/**
 * Adds every shard of `plan` to `pool`, waiting for those other tasks still
 * write. Gives up at the deadline, or at once when only this task's own
 * shards are missing (it stopped for time, so nobody else writes them).
 */
export async function collectShards(
  store: CollectionStore,
  plan: ShardPlan,
  dims: number,
  pool: VectorPool,
  tasks: number,
  o: CollectOptions,
): Promise<void> {
  const pending = new Set(plan.names.map((_, i) => i));
  for (;;) {
    for (const i of [...pending]) {
      const data = await store.readIfExists(plan.names[i] as string);
      if (!data) continue;
      for (const [key, v] of decodeVectorShard(data, dims)) pool.setByKey(key, v);
      pending.delete(i);
    }
    if (pending.size === 0) return;
    const missing = [...pending];
    if (missing.every((i) => i % tasks === 0))
      throw new ShardsMissingError(missing, plan.names.length, tasks, "time");
    if (o.now() >= o.deadline)
      throw new ShardsMissingError(missing, plan.names.length, tasks, "tasks");
    await o.sleep(o.pollMs);
  }
}
