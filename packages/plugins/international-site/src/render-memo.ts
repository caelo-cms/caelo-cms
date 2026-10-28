// SPDX-License-Identifier: MPL-2.0

/**
 * #1213 — what this plugin read during ONE render pass, reused by the
 * pass's other composition points.
 *
 * An editor preview asks this plugin, for the same page, for URL
 * annotations, the language switcher (`language_links`), hreflang
 * (`head_contributions`), the link partition and the chrome variants. Each
 * of them needs the locale registry and the page's variant group; reading
 * them once per point made a preview cost a dozen reads more than it needs.
 *
 * Scope is the pass, never longer: core hands every call of one pass the
 * same `invocation.renderId` and the next pass a new one. Nothing tells
 * this plugin when its rows or the page statuses change between passes, so
 * a cache that outlived the pass would serve a stale switcher. Outside a
 * pass (tools, workers, builds without a render id) every call reads
 * fresh. The store keeps a handful of recent passes and drops them after a
 * minute; a pass that is still running past that simply reads again.
 */

/** Concurrent passes kept (two editors, a screenshot, a live-edit refresh…). */
const MAX_PASSES = 16;
/** A pass older than this is dropped even if it is still in the store. */
const PASS_TTL_MS = 60_000;

/**
 * Per-key memo of a batched read: keys asked together load together,
 * keys already loaded (or loading) are not read again. A failed load is
 * forgotten, so the next call reads again instead of replaying the error.
 */
export class BatchMemo<V> {
  private readonly entries = new Map<string, Promise<V>>();

  /**
   * The value of every key, loading the missing ones in one `load` call.
   *
   * @param absent the value of a key `load` did not answer for.
   */
  async getMany(
    keys: readonly string[],
    load: (missing: string[]) => Promise<ReadonlyMap<string, V>>,
    absent: V,
  ): Promise<Map<string, V>> {
    const unique = [...new Set(keys)];
    const missing = unique.filter((k) => !this.entries.has(k));
    if (missing.length > 0) {
      const batch = load(missing);
      for (const key of missing) {
        const entry = batch.then((m) => (m.has(key) ? (m.get(key) as V) : absent));
        // Handled here so a key nobody awaits after the first failure does
        // not surface as an unhandled rejection; awaiting it still throws.
        entry.catch(() => {
          if (this.entries.get(key) === entry) this.entries.delete(key);
        });
        this.entries.set(key, entry);
      }
    }
    // Take every promise BEFORE awaiting any: a failed batch evicts its
    // keys while an earlier await is pending, and a lookup after that would
    // read `undefined` — a failed read silently turned into "absent".
    const pending = unique.map((key) => [key, this.entries.get(key) as Promise<V>] as const);
    const out = new Map<string, V>();
    for (const [key, entry] of pending) out.set(key, await entry);
    return out;
  }
}

/** One value per pass, loaded on first use; a failed load is forgotten. */
export class OnceMemo<V> {
  private value: Promise<V> | null = null;

  get(load: () => Promise<V>): Promise<V> {
    if (this.value) return this.value;
    const loading = load();
    this.value = loading;
    loading.catch(() => {
      if (this.value === loading) this.value = null;
    });
    return loading;
  }
}

/** Everything one pass may share. Fields are added by the reads that use them. */
export interface RenderMemo {
  readonly createdAt: number;
  readonly onces: Map<string, OnceMemo<unknown>>;
  readonly batches: Map<string, BatchMemo<unknown>>;
}

const passes = new Map<string, RenderMemo>();

/** A fresh memo, used once: the no-sharing path takes the same code. */
function throwaway(): RenderMemo {
  return { createdAt: Date.now(), onces: new Map(), batches: new Map() };
}

/**
 * The memo of the render pass `ctx` belongs to, or a throwaway one when
 * the call is not part of a pass (then nothing is shared).
 */
export function renderMemoOf(ctx: unknown): RenderMemo {
  const invocation = (ctx as { invocation?: { origin?: string; renderId?: unknown } } | undefined)
    ?.invocation;
  const renderId = invocation?.origin === "render" ? invocation.renderId : undefined;
  if (typeof renderId !== "string" || renderId.length === 0) return throwaway();
  const now = Date.now();
  for (const [id, memo] of passes) {
    if (now - memo.createdAt > PASS_TTL_MS) passes.delete(id);
  }
  const existing = passes.get(renderId);
  if (existing) return existing;
  const memo = throwaway();
  passes.set(renderId, memo);
  // Map iteration is insertion order: the first key is the oldest pass.
  while (passes.size > MAX_PASSES) {
    const oldest = passes.keys().next().value;
    if (oldest === undefined) break;
    passes.delete(oldest);
  }
  return memo;
}

/** The pass's single value under `name`. */
export function onceIn<V>(memo: RenderMemo, name: string, load: () => Promise<V>): Promise<V> {
  let once = memo.onces.get(name);
  if (!once) {
    once = new OnceMemo<unknown>();
    memo.onces.set(name, once);
  }
  return (once as OnceMemo<V>).get(load);
}

/** The pass's per-key memo under `name`. */
export function batchIn<V>(memo: RenderMemo, name: string): BatchMemo<V> {
  let batch = memo.batches.get(name);
  if (!batch) {
    batch = new BatchMemo<unknown>();
    memo.batches.set(name, batch);
  }
  return batch as BatchMemo<V>;
}
