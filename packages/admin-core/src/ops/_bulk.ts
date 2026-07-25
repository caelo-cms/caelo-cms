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
 *    If any item's handler returns an `err` Result we THROW
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
  OperationAbortError,
  type OperationDefinition,
} from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
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
      const results: O[] = [];
      for (let i = 0; i < input.items.length; i += 1) {
        const item = input.items[i] as I;
        const r = await singular.handler(ctx, item, tx);
        if (!r.ok) {
          const inner = r.error as { message?: string; kind: string };
          // THROW (never `return err`) so the framework rolls back every item
          // written so far — a partial batch would otherwise commit. The
          // message names the failing index so the AI can fix + resend.
          throw new OperationAbortError({
            kind: "HandlerError",
            operation: name,
            message: `items[${i}]: ${inner.message ?? inner.kind}. The whole batch was rolled back — fix this item and resend all ${input.items.length}.`,
          });
        }
        results.push(r.value);
      }
      return ok({ results, count: results.length });
    },
  });
}
