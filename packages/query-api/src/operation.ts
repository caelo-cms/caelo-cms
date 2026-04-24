// SPDX-License-Identifier: MPL-2.0

import type { ActorKind, ExecutionContext, Result } from "@caelo/shared";
import type { z } from "zod";
import type { QueryError } from "./errors.js";

/**
 * `TransactionRunner` is the injected DB surface inside a handler. It wraps a
 * drizzle transaction that already has `SET LOCAL caelo.actor_id / actor_kind /
 * plugin_id` applied, so every query runs under the caller's identity with RLS
 * policies live. Exact shape is filled in by the Adapter at runtime — handlers
 * see an opaque handle they pass to drizzle query builders.
 */
export interface TransactionRunner {
  readonly __brand: "TransactionRunner";
}

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
