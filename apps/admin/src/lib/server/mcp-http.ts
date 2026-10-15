// SPDX-License-Identifier: MPL-2.0

/**
 * Shared shell for the `/api/mcp/*` endpoints. Each one resolves the
 * bearer inside a system-scoped op (the token is in the op input), so
 * every route dispatches with the same system context and maps the
 * op's failure to HTTP the same way: `auth_error:` → 401, op-input
 * validation → 400 with the issues (the caller's mistake, not a server
 * fault — review finding, PR #379), anything else → 500.
 */

import { type QueryError, SYSTEM_ACTOR_ID } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";

/** The system context an `/api/mcp/*` route dispatches its op with. */
export function mcpSystemCtx(requestId: string): ExecutionContext {
  return { actorId: SYSTEM_ACTOR_ID, actorKind: "system", requestId };
}

/** HTTP status + message for a failed `/api/mcp/*` op. */
export function mcpOpFailure(
  e: QueryError,
  operation: string,
): { readonly status: 400 | 401 | 500; readonly message: string } {
  const msg = "message" in e ? e.message : e.kind;
  if (msg.startsWith("auth_error:")) return { status: 401, message: msg };
  if (e.kind === "ValidationFailed") {
    return { status: 400, message: `invalid request: ${JSON.stringify(e.issues)}` };
  }
  return { status: 500, message: msg || `${operation} failed` };
}
