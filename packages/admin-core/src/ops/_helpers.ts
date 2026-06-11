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
 * Convert Date/string-ish DB timestamp values to ISO; throw when missing.
 */
export function toIsoRequired(value: string | Date | null | undefined, field: string): string {
  const iso = toIso(value);
  if (iso === null) throw new Error(`${field} is required`);
  return iso;
}

/**
 * Map one DB row into typed API output and validate it against the declared
 * operation output schema. This keeps row mappers honest at the op boundary:
 * if a mapper drops/renames fields or emits the wrong type, parsing fails
 * loudly instead of silently returning malformed output.
 */
export function mapRowToOutput<TRow, TOutput>(
  row: TRow,
  outputSchema: z.ZodType<TOutput>,
  mapper: (row: TRow) => unknown,
): TOutput {
  return outputSchema.parse(mapper(row));
}
