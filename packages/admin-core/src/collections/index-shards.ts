// SPDX-License-Identifier: MPL-2.0

/**
 * A wide index attempt: when a build has more passage text to embed than
 * one task embeds in a few minutes (a first index with semantic search or
 * a model change; about 800,000 passages on a 50,000-page site), the
 * attempt runs several tasks (reporting-jobs `MAX_JOB_TASKS`).
 *
 * Every task plans the same build, from the same change files over the
 * same previous release, so they agree on the texts to embed without
 * talking to each other. Each embeds every `count`-th of them and writes
 * the vectors to a shard file. The first task then waits for every shard,
 * adds them to its pool and builds the release, embedding nothing more.
 *
 * A shard file is named after the model and the texts it holds. An attempt
 * that died leaves its finished shards to the next one, which embeds only
 * the missing ones again. The files live under the collection's prefix and
 * go with the clean-up like every file no release names (gc.ts), never
 * while an index job of the collection runs.
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

/** The first task stopped waiting while other tasks' vectors were still missing. */
export class ShardsMissingError extends Error {
  constructor(
    readonly missing: readonly number[],
    count: number,
  ) {
    super(
      `the vectors of task(s) ${missing.join(", ")} of ${count} did not arrive in time: those tasks stopped (their Cloud Run task logs say why); the next attempt embeds only what is still missing`,
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

/** How a wide attempt splits the texts to embed: the shard files and each task's share. */
export interface ShardPlan {
  /** Store names of the shard files, by task index. */
  readonly names: readonly string[];
  /** Task `index`'s share: its texts by pool key. */
  share(index: number): (readonly [string, string])[];
}

/** Splits `missing` across `count` tasks, the same way in every task. */
export function planShards(
  fingerprint: string,
  missing: ReadonlyMap<string, string>,
  count: number,
): ShardPlan {
  const keys = [...missing.keys()].sort();
  const shares = Array.from({ length: count }, (_, i) =>
    keys.filter((_, j) => j % count === i).map((k) => [k, missing.get(k) as string] as const),
  );
  const names = shares.map((share, i) => {
    const h = createHash("sha256");
    h.update(`${fingerprint}\u0000${count}\u0000${i}`);
    for (const [k] of share) h.update(`\u0000${k}`);
    return `vectors/v-${h.digest("hex").slice(0, 32)}.bin`;
  });
  return { names, share: (i) => shares[i] ?? [] };
}

/**
 * Embeds `share` and writes it to `name`, unless an earlier attempt did.
 *
 * @returns how many texts this call embedded.
 */
export async function embedShard(
  store: CollectionStore,
  name: string,
  share: readonly (readonly [string, string])[],
  embedder: Embedder,
  onEmbedded: (embedded: number) => Promise<void>,
): Promise<number> {
  if (share.length === 0 || (await store.has(name))) {
    await onEmbedded(share.length);
    return 0;
  }
  const entries: [string, EncodedVector][] = [];
  for (let i = 0; i < share.length; i += SHARD_EMBED_BATCH) {
    const batch = share.slice(i, i + SHARD_EMBED_BATCH);
    const vectors = await embedder.embed(
      batch.map(([, text]) => text),
      "passage",
    );
    batch.forEach(([key], at) => {
      entries.push([key, encodeVector(vectors[at] as Float32Array)]);
    });
    await onEmbedded(entries.length);
  }
  await store.write(name, encodeVectorShard(entries, embedder.model.dims), { immutable: true });
  return entries.length;
}

/** How the first task waits for the others. */
export interface CollectOptions {
  /** When it stops waiting (epoch ms). */
  readonly deadline: number;
  readonly pollMs: number;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

/** Adds every shard of `plan` to `pool`, waiting for those other tasks still write. */
export async function collectShards(
  store: CollectionStore,
  plan: ShardPlan,
  dims: number,
  pool: VectorPool,
  o: CollectOptions,
): Promise<void> {
  const pending = new Set(plan.names.map((_, i) => i));
  for (;;) {
    for (const i of [...pending]) {
      if (plan.share(i).length === 0) {
        pending.delete(i);
        continue;
      }
      const data = await store.readIfExists(plan.names[i] as string);
      if (!data) continue;
      for (const [key, v] of decodeVectorShard(data, dims)) pool.setByKey(key, v);
      pending.delete(i);
    }
    if (pending.size === 0) return;
    if (o.now() >= o.deadline) throw new ShardsMissingError([...pending], plan.names.length);
    await o.sleep(o.pollMs);
  }
}
