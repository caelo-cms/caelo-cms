// SPDX-License-Identifier: MPL-2.0

import type { QueryError, TransactionRunner } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
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

/**
 * Run `fn` with this transaction's RLS session switched to `system`, then
 * switch back to the caller's kind.
 *
 * `users` and `actors` carry self-or-system RLS: a human or AI session sees
 * and writes only its OWN row. The user-management ops act on OTHER users by
 * definition, so their lookups and the approved apply must run as system —
 * the op's actorScope, the route's permission guard and (for proposals) the
 * Owner's approval click are the authorization; RLS here only ever hid the
 * rows those checks already allowed. `ctx.actorId` is untouched, so audit
 * rows stay attributed to the real actor. Not restored when `fn` throws: the
 * transaction is rolled back then anyway.
 */
export async function withSystemRls<T>(
  tx: TransactionRunner,
  ctx: Pick<ExecutionContext, "actorKind">,
  fn: () => Promise<T>,
): Promise<T> {
  await tx.execute(sql`SELECT set_config('caelo.actor_kind', 'system', true)`);
  const result = await fn();
  await tx.execute(sql`SELECT set_config('caelo.actor_kind', ${ctx.actorKind}, true)`);
  return result;
}
