// SPDX-License-Identifier: MPL-2.0

import type { OperationHandler, QueryError } from "@caelo-cms/query-api";
import type { Result } from "@caelo-cms/shared";
import { recordAuditFromCtx } from "../audit.js";

interface AuditOptions<I, O> {
  operation: string;
  entityId?: (input: I, result: Result<O, QueryError>) => string | null | undefined;
  resultSummary?: (input: I, result: Result<O, QueryError>) => string | null | undefined;
}

/**
 * Wrap an op handler and emit its audit row in one place.
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
