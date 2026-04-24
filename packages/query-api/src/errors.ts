// SPDX-License-Identifier: MPL-2.0

import type { z } from "zod";

/**
 * Tagged error union returned from `execute()`. Each case is the app-level response
 * to a specific failure mode. Crashes / connection loss still throw.
 */
export type QueryError =
  | { readonly kind: "UnknownOperation"; readonly name: string }
  | { readonly kind: "ValidationFailed"; readonly issues: z.ZodIssue[] }
  | { readonly kind: "ActorScopeRejected"; readonly operation: string; readonly actorKind: string }
  | { readonly kind: "RateLimited"; readonly operation: string; readonly retryAfterMs?: number }
  | { readonly kind: "RLSDenied"; readonly operation: string; readonly detail: string }
  | { readonly kind: "HandlerError"; readonly operation: string; readonly message: string };

/**
 * Postgres error codes that mean "RLS denied the row" — either `USING` filtered
 * all rows (read attempts return empty — no error) or `WITH CHECK` rejected a
 * write (error code 42501 = insufficient_privilege).
 */
export const PG_INSUFFICIENT_PRIVILEGE = "42501";

export function isRlsDenial(error: unknown): boolean {
  // Drizzle wraps driver errors in a DrizzleQueryError whose `.cause` is the
  // underlying PostgresError — walk the chain (up to a small depth) so the
  // detector works regardless of where in the stack the error surfaces.
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    // Bun.SQL surfaces the Postgres SQLSTATE as `.errno`; pg-style drivers use `.code`.
    const errno = (current as { errno?: unknown }).errno;
    const code = (current as { code?: unknown }).code;
    if (errno === PG_INSUFFICIENT_PRIVILEGE || code === PG_INSUFFICIENT_PRIVILEGE) return true;
    const message = (current as { message?: unknown }).message;
    if (
      typeof message === "string" &&
      message.toLowerCase().includes("violates row-level security")
    )
      return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
