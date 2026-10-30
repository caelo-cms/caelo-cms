// SPDX-License-Identifier: MPL-2.0

/**
 * DRY bulk-op factory (CLAUDE.md §11 — "every routine domain ships a bulk
 * variant alongside the singular form ... the bulk handler validates + writes
 * inside one transaction so partial-failure is impossible").
 *
 * `defineBulkOp` turns any existing singular op into an `_many` variant by
 * running N invocations of the SAME singular handler inside the ONE shared
 * transaction the framework already opens for the bulk op. This buys three
 * properties with zero logic duplication:
 *
 *  - **One-transaction atomicity.** Every item commits together or none do.
 *    Every item runs (so every failing index is reported at once, #1277);
 *    if any item's handler returned an `err` Result we THROW
 *    `OperationAbortError`, which the adapter catches to roll the WHOLE
 *    transaction back (a bare `return err` after an earlier item already
 *    wrote would COMMIT that partial work — see query-api/errors.ts). A
 *    half-applied batch is therefore impossible.
 *  - **No reimplementation.** The bulk handler reuses the singular op's
 *    `handler` verbatim, so every validation rule, audit row, snapshot and
 *    branch-overlay behaviour the singular path emits applies unchanged.
 *  - **Inherited contract.** `actorScope` and `database` are taken from the
 *    singular op, so the bulk variant can never drift from the singular's
 *    permission surface or DB target. Input is `{ items: [singular.input, …] }`
 *    (strict, 1..maxItems); output is `{ results: [singular.output, …], count }`.
 */

import {
  defineOperation,
  type ErrorDetail,
  errorDetailsOf,
  failureKindOf,
  handlerErrorFromDetails,
  OperationAbortError,
  type OperationDefinition,
  prefixErrorDetails,
  type QueryError,
  thrownToQueryError,
} from "@caelo-cms/query-api";
import { ok, type Result } from "@caelo-cms/shared";
import { z } from "zod";

/** Default cap on items per bulk call — bounds the per-tx work + token cost. */
const DEFAULT_MAX_ITEMS = 200;

/** Configuration for {@link defineBulkOp}. */
export interface DefineBulkOpConfig<I, O> {
  /** Fully-qualified op name, e.g. `"content_instances.set_values_many"`. */
  readonly name: string;
  /**
   * The per-item op whose `handler` / `input` / `output` / `actorScope` /
   * `database` are reused. Its input Zod schema becomes the array element
   * schema; its output schema becomes the per-result schema.
   */
  readonly singular: OperationDefinition<I, O>;
  /** Max items accepted per call (default {@link DEFAULT_MAX_ITEMS}). */
  readonly maxItems?: number;
}

/**
 * Build an `_many` bulk op that applies `config.singular` to each of `items`
 * inside the single shared transaction. See the file header for the
 * one-transaction atomicity guarantee — a failing item throws and rolls the
 * whole batch back, so callers never see a partial write.
 *
 * @param config the bulk-op name, the singular op to reuse, and an optional cap.
 * @returns an `OperationDefinition` ready to `registry.register(...)`.
 */
export function defineBulkOp<I, O>(
  config: DefineBulkOpConfig<I, O>,
): OperationDefinition<{ items: I[] }, { results: O[]; count: number }> {
  const { name, singular, maxItems = DEFAULT_MAX_ITEMS } = config;
  return defineOperation({
    name,
    actorScope: singular.actorScope,
    database: singular.database,
    input: z.object({ items: z.array(singular.input).min(1).max(maxItems) }).strict(),
    output: z.object({ results: z.array(singular.output), count: z.number() }),
    handler: async (ctx, input, tx) => {
      const run = await runEveryItem(name, "items", input.items, (item) =>
        singular.handler(ctx, item, tx),
      );
      // THROW (never `return err`) so the framework rolls back every item
      // written — a partial batch would otherwise commit.
      if (!run.ok) throw new OperationAbortError(run.error);
      return ok({ results: run.results, count: run.results.length });
    },
  });
}

/**
 * Issue #1277 — run every item of a batch and report EVERY failing index
 * at once, each problem under `[arrayKey, i, …]`. Items keep running after
 * a failure so the caller fixes all of them in one go; only a throw that
 * is not an `OperationAbortError` (a driver error, which leaves Postgres'
 * transaction aborted) stops the loop. The caller decides how to fail:
 * throw `OperationAbortError(error)` when anything may have been written.
 *
 * @returns every item's value, or one HandlerError naming all failures
 *   (`refusal` when an item's guard refused, `internal` when an item hit
 *   a defect) plus how many items may have written (succeeded, or aborted
 *   after a write) — the caller throws when that is not 0.
 */
export async function runEveryItem<T, R>(
  operation: string,
  arrayKey: string,
  items: readonly T[],
  run: (item: T, index: number) => Promise<Result<R, QueryError>>,
): Promise<{ ok: true; results: R[] } | { ok: false; error: QueryError; writtenItems: number }> {
  const results: R[] = [];
  const failures: ErrorDetail[] = [];
  const failedIndices = new Set<number>();
  let refusal = false;
  let internal = false;
  let aborted = 0;
  for (let i = 0; i < items.length; i += 1) {
    let r: Result<R, QueryError>;
    try {
      r = await run(items[i] as T, i);
    } catch (thrown) {
      if (!(thrown instanceof OperationAbortError)) {
        const error = thrownToQueryError(operation, thrown, "write");
        if (failureKindOf(error) === "internal") internal = true;
        failures.push(...itemFailures(arrayKey, i, error));
        failedIndices.add(i);
        aborted += 1;
        break;
      }
      // An abort is thrown once something was written (the op contract,
      // errors.ts): this item may have written, so the batch must roll back.
      aborted += 1;
      r = { ok: false, error: thrown.queryError };
    }
    if (r.ok) {
      results.push(r.value);
      continue;
    }
    failures.push(...itemFailures(arrayKey, i, r.error));
    failedIndices.add(i);
    if (r.error.kind === "HandlerError" && r.error.refusal) refusal = true;
    if (failureKindOf(r.error) === "internal") internal = true;
  }
  if (failures.length === 0) return { ok: true, results };
  return {
    ok: false,
    // Items that succeeded wrote, and so may an item that aborted after its
    // first write (it threw instead of returning); an item that RETURNED
    // its error failed before its first write (the op contract, errors.ts).
    writtenItems: results.length + aborted,
    error: handlerErrorFromDetails(operation, failures, {
      lead: `${failedIndices.size} of ${items.length} ${arrayKey} failed; nothing was written.`,
      refusal,
      internal,
    }),
  };
}

/**
 * One failed item's problems under `[arrayKey, i]`: its own `errors[]`
 * with their paths prefixed, or its whole message at `[arrayKey, i]`.
 */
export function itemFailures(arrayKey: string, index: number, error: QueryError): ErrorDetail[] {
  const details = errorDetailsOf(error);
  if (details.length > 0) return prefixErrorDetails([arrayKey, index], details);
  const message =
    "message" in error && typeof error.message === "string"
      ? error.message
      : "detail" in error && typeof error.detail === "string"
        ? error.detail
        : error.kind;
  return [{ path: [arrayKey, index], message }];
}
