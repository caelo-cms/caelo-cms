// SPDX-License-Identifier: MPL-2.0

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ActorKind, ExecutionContext, Result } from "@caelo-cms/shared";
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
 * Op-coverage instrumentation (issue #14, CLAUDE.md §6 "integration ≥ 80% of
 * declared Query API ops"). This is a TEST-ONLY measurement hook, inert in
 * production and during ordinary `bun test` runs: `defineOperation` only wraps
 * the handler when `CAELO_OP_COVERAGE === "1"`, which the coverage gate
 * (`scripts/coverage-check.ts`) sets solely for the integration test pass.
 * When unset, `defineOperation` returns its argument unchanged (zero overhead).
 *
 * `defineOperation` is the one chokepoint common to BOTH the
 * `execute(registry, adapter, ctx, "name", …)` dispatch path and the direct
 * `op.handler(...)` calls that many integration tests use, so wrapping here
 * captures every exercised op regardless of how the test invokes it.
 */
const OP_COVERAGE_FILE_DEFAULT = "coverage/op-coverage.jsonl";

/**
 * Names already appended in THIS JS context, to avoid re-appending on every
 * handler call. Under `bun test --isolate` each test file gets a fresh global,
 * so this Set resets per file — the on-disk append-log is the cross-file source
 * of truth, which the gate script unions + de-dupes. Recording is therefore
 * "first invocation per op per file"; duplicate lines across files are expected
 * and harmless.
 */
const recordedNames = new Set<string>();
let coverageDirEnsured = false;

function recordOpInvocation(name: string): void {
  if (recordedNames.has(name)) return;
  recordedNames.add(name);
  const file = process.env.CAELO_OP_COVERAGE_FILE ?? OP_COVERAGE_FILE_DEFAULT;
  if (!coverageDirEnsured) {
    mkdirSync(dirname(file), { recursive: true });
    coverageDirEnsured = true;
  }
  // `flag: "a"` (O_APPEND) keeps concurrent isolate writers from clobbering
  // each other. A failure here throws and fails the test loudly rather than
  // silently undercounting (CLAUDE.md §2 — no silent fallbacks).
  appendFileSync(file, `${name}\n`, { flag: "a" });
}

/**
 * Type-preserving constructor. Use this (never the literal `OperationDefinition`
 * type) so every op's input/output Zod schemas flow through to callers.
 *
 * When `CAELO_OP_COVERAGE === "1"` the handler is wrapped to record the op's
 * name on first invocation (see the instrumentation note above); otherwise the
 * definition is returned untouched.
 */
export function defineOperation<I, O>(def: OperationDefinition<I, O>): OperationDefinition<I, O> {
  if (process.env.CAELO_OP_COVERAGE !== "1") return def;
  const original = def.handler;
  return {
    ...def,
    handler: (ctx, input, tx) => {
      // Record before invoking so an op that is reached but throws/rejects
      // still counts as exercised ("was reached", not "succeeded").
      recordOpInvocation(def.name);
      return original(ctx, input, tx);
    },
  };
}
