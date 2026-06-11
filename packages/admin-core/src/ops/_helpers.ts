// SPDX-License-Identifier: MPL-2.0

import type { QueryError } from "@caelo-cms/query-api";
import type { z } from "zod";

type HandlerError = Extract<QueryError, { kind: "HandlerError" }>;

/**
 * Build the canonical Query API HandlerError shape for operation handlers.
 */
export function opError(
  operation: string,
  message: string,
  extra: Omit<HandlerError, "kind" | "operation" | "message"> = {},
): HandlerError {
  return {
    kind: "HandlerError",
    operation,
    message,
    ...extra,
  };
}

/**
 * Convert Date/string-ish DB timestamp values to an ISO string.
 */
export function toIso(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * Map one DB row into typed API output and validate it against the output schema.
 */
export function mapRowToOutput<TRow, TOutput>(
  row: TRow,
  outputSchema: z.ZodType<TOutput>,
  mapper: (row: TRow) => unknown,
): TOutput {
  return outputSchema.parse(mapper(row));
}
