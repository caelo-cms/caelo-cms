// SPDX-License-Identifier: MPL-2.0

import type { ExecutionContext, Result } from "@caelo/shared";
import { err, isErr } from "@caelo/shared";
import type { DatabaseAdapter } from "./adapter.js";
import type { QueryError } from "./errors.js";
import type { OperationRegistry } from "./registry.js";

/**
 * Top-level Query API entry point. No other path reaches the database.
 *
 *   lookup op → scope-check actor → zod-validate input → adapter runs it in a txn
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

  const parsed = op.input.safeParse(rawInput);
  if (!parsed.success) {
    return err({ kind: "ValidationFailed", issues: parsed.error.issues });
  }

  return adapter.runOperation(op, ctx, parsed.data);
}
