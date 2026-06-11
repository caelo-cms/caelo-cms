// SPDX-License-Identifier: MPL-2.0

import type { OperationHandler, QueryError } from "@caelo-cms/query-api";
import type { Result } from "@caelo-cms/shared";
import { recordAuditFromCtx } from "../audit.js";

interface AuditOptions<I, O> {
  operation: string;
  /** Optional extractor for the audited entity id. `null`/`undefined` are both stored as NULL. */
  entityId?: (input: I, result: Result<O, QueryError>) => string | null | undefined;
  /** Optional summary extractor. `null`/`undefined` mean "no explicit summary". */
  resultSummary?: (input: I, result: Result<O, QueryError>) => string | null | undefined;
}

/**
 * Wrap an operation handler and emit exactly one audit row from the same
 * execution context/transaction. The wrapper records success/failure and can
 * attach optional entity-id + summary metadata via extractors.
 */
export function withAudit<I, O>(
  handler: OperationHandler<I, O>,
  options: AuditOptions<I, O>,
): OperationHandler<I, O> {
  return async (ctx, input, tx) => {
    const result = await handler(ctx, input, tx);
    await recordAuditFromCtx(tx, ctx, {
      operation: options.operation,
      input,
      succeeded: result.ok,
      entityId: options.entityId?.(input, result) ?? null,
      resultSummary:
        options.resultSummary?.(input, result) ??
        (result.ok
          ? null
          : result.error.kind === "HandlerError"
            ? result.error.message
            : result.error.kind),
    });
    return result;
  };
}
