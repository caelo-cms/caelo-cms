// SPDX-License-Identifier: MPL-2.0

/**
 * A large index build in pieces: when a build has more passage text to
 * embed than one shard holds (a first index with semantic search or a
 * model change; about 800,000 passages on a 50,000-page site), it embeds
 * the texts in shard files of {@link SHARD_PASSAGES}, and several tasks may
 * work on them at once.
 *
 * Every task plans the same build, from the same change files over the
 * same previous release, so they agree on the shards without talking to
 * each other. Which task embeds which shard is the admin's (#1776): each
 * task claims the next open shard (`job_pieces.claim`), embeds it, writes
 * its file and reports it done. The attempt's lead claims too, and once
 * every shard is done it adds them all to its pool and builds the release,
 * embedding nothing more. Helpers the capacity ledger adds while CPU is
 * free take what is left; a helper that hears `stop` (a job of a higher
 * class needs its CPU) ends after the shard it finished.
 *
 * A shard file is named after the model and the texts it holds (a hash
 * bucket of them, {@link planShards}), and a finished one is never embedded
 * again. So an attempt that died or ran out of time leaves its finished
 * shards to the next one, and a later Stage with nearly the same texts to
 * embed keeps most of them: a narrow width only takes longer. The files
 * live under the collection's prefix and go with the clean-up like every
 * file no release names (gc.ts), never while an index job of the
 * collection runs.
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

/** Texts sent to the model per call while a task embeds a shard. */
const SHARD_EMBED_BATCH = 32;

/**
 * Texts per shard file: a few minutes of one task (6 to 19 passages a
 * second on 2 vCPU, index-job.ts), so a task that dies loses at most that,
 * and a helper that must give its CPU back gives it within that.
 */
export const SHARD_PASSAGES = 2_000;

/** The attempt's time ended with shards still missing; the next one embeds only those. */
export class ShardsMissingError extends Error {
  constructor(
    readonly missing: number,
    readonly total: number,
  ) {
    super(
      `${missing} of ${total} pieces of the search index were not embedded within this attempt's time; the next attempt embeds only those (the time a large index takes falls with the tasks the project's CPU quota allows)`,
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
  return { names, texts: (i) => used[i]?.texts ?? [] };
}

/** The shards of `plan` whose files exist already (an earlier attempt or Stage wrote them). */
export async function writtenShards(store: CollectionStore, plan: ShardPlan): Promise<number[]> {
  const out: number[] = [];
  for (const [i, name] of plan.names.entries()) if (await store.has(name)) out.push(i);
  return out;
}

/**
 * Embeds shard `shard` of `plan` into its file, unless the file exists.
 *
 * @param onBatch - called with this shard's texts embedded so far.
 * @returns the texts this call embedded (0 when the file existed).
 */
export async function embedShard(
  store: CollectionStore,
  plan: ShardPlan,
  shard: number,
  embedder: Embedder,
  onBatch: (embeddedInShard: number) => Promise<void>,
): Promise<number> {
  const name = plan.names[shard] as string;
  if (await store.has(name)) return 0;
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
    await onBatch(entries.length);
  }
  await store.write(name, encodeVectorShard(entries, embedder.model.dims), { immutable: true });
  return entries.length;
}

/**
 * Adds every shard of `plan` to `pool`. The lead calls it once the admin
 * says every shard is done.
 *
 * @throws ShardsMissingError when a file is missing after all.
 */
export async function collectShards(
  store: CollectionStore,
  plan: ShardPlan,
  dims: number,
  pool: VectorPool,
): Promise<void> {
  let missing = 0;
  for (const name of plan.names) {
    const data = await store.readIfExists(name);
    if (!data) {
      missing += 1;
      continue;
    }
    for (const [key, v] of decodeVectorShard(data, dims)) pool.setByKey(key, v);
  }
  if (missing > 0) throw new ShardsMissingError(missing, plan.names.length);
}
