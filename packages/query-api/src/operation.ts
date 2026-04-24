// SPDX-License-Identifier: MPL-2.0

import type { ActorKind, ExecutionContext, Result } from "@caelo/shared";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type { z } from "zod";
import type { QueryError } from "./errors.js";

/**
 * The database handle a handler receives. We extract it directly from
 * drizzle's `BunSQLDatabase.transaction` signature so `handler` bodies get
 * full typing on `tx.execute(sql`...`)`, `tx.select()`, etc. — no branded
 * placeholder, no `as unknown as` casts. The transaction is already wrapped
 * in `set_config('caelo.actor_id' / 'actor_kind' / 'plugin_id', ..., true)`
 * by the Adapter so RLS policies evaluate under the caller's identity.
 *
 * No schema generic is carried here — handlers use the `sql` template tag
 * for ad-hoc queries in P1. P3+ (which introduces drizzle schema objects)
 * can introduce a schema-aware variant if needed.
 */
export type TransactionRunner = Parameters<Parameters<BunSQLDatabase["transaction"]>[0]>[0];

export type OperationHandler<I, O> = (
  ctx: ExecutionContext,
  input: I,
  tx: TransactionRunner,
) => Promise<Result<O, QueryError>>;

export interface OperationDefinition<I = unknown, O = unknown> {
  readonly name: string;
  /** Which actor kinds may invoke this op. Validator rejects out-of-scope callers before handler runs. */
  readonly actorScope: readonly ActorKind[];
  /** Which database this op touches. */
  readonly database: "cms_admin" | "cms_public";
  readonly input: z.ZodType<I>;
  readonly output: z.ZodType<O>;
  readonly handler: OperationHandler<I, O>;
}

/**
 * Type-preserving constructor. Use this (never the literal `OperationDefinition`
 * type) so every op's input/output Zod schemas flow through to callers.
 */
export function defineOperation<I, O>(def: OperationDefinition<I, O>): OperationDefinition<I, O> {
  return def;
}
