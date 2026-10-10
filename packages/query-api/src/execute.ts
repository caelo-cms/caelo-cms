// SPDX-License-Identifier: MPL-2.0

import type { ExecutionContext, Result } from "@caelo-cms/shared";
import { err, isErr } from "@caelo-cms/shared";
import type { DatabaseAdapter } from "./adapter.js";
import { branchNotFound, firstMalformedBranch, namedBranches } from "./branch-access.js";
import type { QueryError } from "./errors.js";
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
}

/**
 * Top-level Query API entry point. No other path reaches the database.
 *
 *   lookup op → scope-check actor → rate-limit → malformed-branch check →
 *   zod-validate input → adapter runs it in a txn (branch-visibility gate first)
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
  if (isErr(opLookup)) return opLookup;
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

  return adapter.runOperation(op, ctx, parsed.data);
}
