// SPDX-License-Identifier: MPL-2.0

import type { ExecutionContext, Result } from "@caelo-cms/shared";
import { err, isErr } from "@caelo-cms/shared";
import type { DatabaseAdapter } from "./adapter.js";
import { branchNotFound, firstMalformedBranch, namedBranches } from "./branch-access.js";
import type { QueryError } from "./errors.js";
import { isReadOperation } from "./operation.js";
import { commitNoticeOf, notifyOperationCommitted } from "./post-commit.js";
import type { OperationRegistry } from "./registry.js";

/**
 * Rate-limit hook contract consulted by `execute()` before the Zod validator
 * runs. Stub interface only in P1 — the real implementation lands in P13 at
 * the API Gateway (per requirements §16.1). The shape is fixed now so P13 can
 * plug a gateway-backed limiter in without touching the Query API surface.
 *
 * A limiter returns `null` to allow the call or a `QueryError` to reject it.
 */
export interface RateLimiter {
  check(ctx: ExecutionContext, operationName: string): Promise<QueryError | null>;
}

export const allowAllRateLimiter: RateLimiter = {
  async check() {
    return null;
  },
};

export interface ExecuteOptions {
  readonly rateLimiter?: RateLimiter;
  /**
   * #1211 — handed to a step-wise operation (`defineStepwiseOperation`),
   * which stops at its next step once it aborts. A transactional op runs
   * to its commit or rollback either way.
   */
  readonly signal?: AbortSignal;
}

/**
 * Top-level Query API entry point. No other path reaches the database.
 *
 *   lookup op → scope-check actor → rate-limit → malformed-branch check →
 *   zod-validate input → adapter runs it in a txn (branch-visibility gate first)
 *
 * A step-wise op (`defineStepwiseOperation`) skips the last step: it opens
 * no transaction and runs its steps as ops of their own.
 *
 * Any step can fail and returns a Result.Err without throwing. A thrown error
 * here is always a real bug (registry corrupt, adapter connection gone).
 */
export async function execute(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  ctx: ExecutionContext,
  name: string,
  rawInput: unknown,
  options: ExecuteOptions = {},
): Promise<Result<unknown, QueryError>> {
  const opLookup = registry.lookup(name);
  // Re-wrap the error instead of returning `opLookup` itself: static analysis
  // does not narrow the union, so passing the lookup Result through made the
  // registered op *definition* (e.g. `changePasswordOp`) look like part of
  // every op's output, which flagged every log of any op result as clear-text
  // password logging (docs/dev/codeql.md).
  if (isErr(opLookup)) return err(opLookup.error);
  const op = opLookup.value;

  if (!op.actorScope.includes(ctx.actorKind)) {
    return err({
      kind: "ActorScopeRejected",
      operation: name,
      actorKind: ctx.actorKind,
    });
  }

  const limiter = options.rateLimiter ?? allowAllRateLimiter;
  const limiterVerdict = await limiter.check(ctx, name);
  if (limiterVerdict !== null) return err(limiterVerdict);

  // Issue #569 — a malformed branch id names no branch: answer it exactly
  // like an unknown or invisible one (the adapter's check), not as a
  // schema failure that would tell the two apart.
  const malformed = firstMalformedBranch(namedBranches(ctx, rawInput));
  if (malformed !== null) return err(branchNotFound(name, malformed));

  const parsed = op.input.safeParse(rawInput);
  if (!parsed.success) {
    return err({ kind: "ValidationFailed", issues: parsed.error.issues });
  }

  // #1211 — a step-wise op holds no transaction: each of its steps is an
  // op of its own, executed (and committed) through the same registry.
  if (!isReadOperation(op) && op.stepwise) {
    const result = await op.stepwise(ctx, parsed.data, {
      registry,
      adapter,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    // #1215 — like a transactional op that answered ok (adapter.ts): the
    // change hints hear it, after every step committed.
    if (result.ok) {
      notifyOperationCommitted(op.name);
      // #1267 — and so do other instances. Each step already sent its own
      // notice in its transaction; this is the step-wise op's own name.
      // A failed notice never fails the op: its change is committed, and a
      // retry would apply it twice. Other instances miss one hint; their
      // surfaces re-read on focus or their next topic.
      const notice = commitNoticeOf(op.name);
      if (notice !== null) {
        await adapter.notify(notice.channel, notice.payload).catch((thrown: unknown) => {
          console.error(`[query-api] could not notify other instances of ${op.name}`, thrown);
        });
      }
    }
    return result;
  }
  return adapter.runOperation(op, ctx, parsed.data);
}
