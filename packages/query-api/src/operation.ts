// SPDX-License-Identifier: MPL-2.0

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ActorKind, ExecutionContext, Result } from "@caelo-cms/shared";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type { z } from "zod";
import type { DatabaseAdapter } from "./adapter.js";
import type { QueryError } from "./errors.js";
import type { OperationRegistry } from "./registry.js";

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

/**
 * What a step-wise operation runs its steps through (see
 * {@link defineStepwiseOperation}): the registry and adapter of the
 * `execute()` call that dispatched it, plus that call's abort signal.
 */
export interface OperationSteps {
  readonly registry: OperationRegistry;
  readonly adapter: DatabaseAdapter;
  /** The caller stopped the work; the op stops at its next step. */
  readonly signal?: AbortSignal;
}

/** The body of a step-wise operation: no transaction, its steps are ops of their own. */
export type StepwiseOperationHandler<I, O> = (
  ctx: ExecutionContext,
  input: I,
  steps: OperationSteps,
) => Promise<Result<O, QueryError>>;

/**
 * Issue #1212 — the database access of a read operation that holds no
 * transaction. Each {@link ReadScope.read} call opens one short
 * transaction under the caller's identity (RLS sees the same session
 * settings as in a transactional op), runs `fn`, and commits; between
 * calls the handler holds no pooled connection.
 *
 * `fn` must only query through the `tx` it is handed: awaiting anything
 * that takes its own connection (a plugin call, another op, a second
 * `read`) inside it is exactly the nested checkout that deadlocks a full
 * pool (#1209).
 */
export interface ReadScope {
  read<T>(fn: (tx: TransactionRunner) => Promise<T>): Promise<T>;
}

/**
 * Issue #1267 (rule 7 of docs/dev/state-and-changes.md) — how much of the
 * site one call of an operation may read.
 *
 * - `"request"`: what the request names (a page, its references, a page of
 *   a list), never the whole site. The rows-read test in PR CI holds every
 *   such op to it: its statements and buffers on a 10x larger fixture stay
 *   within 1.5x of the small one.
 * - `"site"`: the operation's purpose is the whole site (the Stage build,
 *   a whole-site link check, an export, a rebuild op). Needs a
 *   `// Why site-wide:` comment at the op definition; a CI guard fails
 *   without it.
 */
export type OperationReadScope = "request" | "site";

/** Handler of a {@link ReadOperationDefinition}. */
export type ReadOperationHandler<I, O> = (
  ctx: ExecutionContext,
  input: I,
  reads: ReadScope,
) => Promise<Result<O, QueryError>>;

/**
 * Issue #1212 — a read-only operation whose work is mostly NOT database
 * work (plugin calls, font I/O, composing a page). A transactional op
 * would hold its connection across all of it, and every plugin storage
 * access inside takes a second checkout from the same pool: N such ops at
 * pool size N deadlock forever. A read operation reads in short
 * transactions ({@link ReadScope}) and holds nothing in between.
 *
 * Only for reads: there is no transaction to commit a write into, no
 * `afterCommit`, and no projection publish. The branch-visibility gate
 * (#569) still runs before the handler.
 */
export interface ReadOperationDefinition<I = unknown, O = unknown> {
  readonly kind: "reads";
  readonly name: string;
  readonly actorScope: readonly ActorKind[];
  /** How much of the site one call reads (#1267, {@link OperationReadScope}). */
  readonly readScope: OperationReadScope;
  /** Read operations read the authoring database. */
  readonly database: "cms_admin";
  readonly input: z.ZodType<I>;
  readonly output: z.ZodType<O>;
  readonly handler: ReadOperationHandler<I, O>;
}

/** Anything the registry holds: a transactional or a read operation. */
export type AnyOperationDefinition<I = unknown, O = unknown> =
  | OperationDefinition<I, O>
  | ReadOperationDefinition<I, O>;

/** Whether `op` is a {@link ReadOperationDefinition}. */
export function isReadOperation<I, O>(
  op: AnyOperationDefinition<I, O>,
): op is ReadOperationDefinition<I, O> {
  return "kind" in op && op.kind === "reads";
}

export interface OperationDefinition<I = unknown, O = unknown> {
  readonly name: string;
  /** Which actor kinds may invoke this op. Validator rejects out-of-scope callers before handler runs. */
  readonly actorScope: readonly ActorKind[];
  /** How much of the site one call reads (#1267, {@link OperationReadScope}). */
  readonly readScope: OperationReadScope;
  /** Which database this op touches. */
  readonly database: "cms_admin" | "cms_public";
  readonly input: z.ZodType<I>;
  readonly output: z.ZodType<O>;
  readonly handler: OperationHandler<I, O>;
  /**
   * Issue #1210 — `"none"` for an op that orchestrates other ops around
   * long foreign work (a whole chat turn, a tool dispatch, downloads): the
   * adapter opens no transaction for it, so no connection sits idle in
   * transaction while the model, a tool or the network runs, and the ops it
   * calls through `execute()` are not nested checkouts. Its handler gets a
   * `tx` that throws on use (pool-guard.ts `detachedRunner`); each step
   * that touches the database is its own op or short
   * `withAdminTransaction`. Omitted: the handler runs inside one
   * transaction, the default for every op that only reads and writes.
   */
  readonly transaction?: "none";
  /**
   * Set by {@link defineStepwiseOperation} only: `execute()` runs this
   * instead of opening a transaction around `handler`. A step-wise op is the
   * detached shape for a body that runs its steps as ops of their own and
   * needs the caller's registry, adapter and abort signal for that; a
   * `transaction: "none"` op runs its steps as short transactions instead.
   */
  readonly stepwise?: StepwiseOperationHandler<I, O>;
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

/**
 * An operation that holds NO transaction while it runs (#1211). Its body
 * orchestrates foreign work — a subprocess, a provider upload — that may
 * take minutes, and runs every database step as an op of its own through
 * `steps` (each one short transaction, committed on its own). Holding one
 * transaction across that work pinned a pooled connection for the whole
 * run, and every progress write took a second one from the same pool: the
 * pool-deadlock class of #1209.
 *
 * Dispatched through `execute()` like any op: actor scope, rate limit and
 * input schema are checked first. There is no transaction to hand a direct
 * `handler(...)` call, so that call throws.
 *
 * @example
 * export const rebuildOp = defineStepwiseOperation({
 *   name: "site.rebuild",
 *   actorScope: ["human", "ai", "system"],
 *   database: "cms_admin",
 *   input: z.object({}),
 *   output: z.object({ runId: z.string() }),
 *   stepwise: async (ctx, _input, { registry, adapter }) => {
 *     const started = await execute(registry, adapter, ctx, "site.start_run", {});
 *     if (!started.ok) return err(started.error);
 *     // …long work without a transaction, then one short op to finish:
 *     const finished = await execute(registry, adapter, ctx, "site.finish_run", started.value);
 *     return finished.ok ? ok(finished.value as { runId: string }) : err(finished.error);
 *   },
 * });
 */
export function defineStepwiseOperation<I, O>(
  def: Omit<OperationDefinition<I, O>, "handler" | "stepwise" | "database"> & {
    readonly database: "cms_admin";
    readonly stepwise: StepwiseOperationHandler<I, O>;
  },
): OperationDefinition<I, O> {
  const body = def.stepwise;
  const stepwise: StepwiseOperationHandler<I, O> =
    process.env.CAELO_OP_COVERAGE === "1"
      ? (ctx, input, steps) => {
          recordOpInvocation(def.name);
          return body(ctx, input, steps);
        }
      : body;
  return {
    ...def,
    stepwise,
    handler: async () => {
      throw new Error(
        `operation '${def.name}' holds no transaction (each step is an op of its own): dispatch it through execute(), never call its handler with a transaction`,
      );
    },
  };
}

/**
 * Constructor of a {@link ReadOperationDefinition} — the read twin of
 * {@link defineOperation}, with the same coverage instrumentation.
 *
 * @example
 *   export const renderThingOp = defineReadOperation({
 *     name: "things.render",
 *     actorScope: ["human", "ai", "system"],
 *     input: z.object({ id: z.string().uuid() }).strict(),
 *     output: z.object({ html: z.string() }),
 *     handler: async (ctx, input, reads) => {
 *       const row = await reads.read((tx) => loadThing(tx, input.id));
 *       return ok({ html: await renderWithPlugins(row) }); // no connection held here
 *     },
 *   });
 */
export function defineReadOperation<I, O>(
  def: Omit<ReadOperationDefinition<I, O>, "kind" | "database">,
): ReadOperationDefinition<I, O> {
  const full: ReadOperationDefinition<I, O> = { ...def, kind: "reads", database: "cms_admin" };
  if (process.env.CAELO_OP_COVERAGE !== "1") return full;
  const original = def.handler;
  return {
    ...full,
    handler: (ctx, input, reads) => {
      recordOpInvocation(def.name);
      return original(ctx, input, reads);
    },
  };
}
