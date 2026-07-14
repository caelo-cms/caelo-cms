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
  | {
      readonly kind: "HandlerError";
      readonly operation: string;
      readonly message: string;
      /**
       * v0.5.17 — when the throw originated from a SQL driver (Bun.SQL,
       * drizzle, pg-postgres), the adapter walks `.cause` and lifts the
       * Postgres-specific fields here so downstream consumers (AI tool
       * `describeError`, /security/audit) can render a structured reason
       * instead of a truncated "Failed query: …" string. Optional —
       * handlers that build their own HandlerError leave it undefined.
       */
      readonly pgDetail?: {
        readonly code?: string;
        readonly constraint?: string;
        readonly table?: string;
        readonly column?: string;
        readonly detail?: string;
      };
      /**
       * v0.6.0 W3 — structured recovery hint. Bootstrap-flow ops set
       * this when the failure has a clear "AI should call X next" path:
       *   - `templates.create` rejecting "no defaults configured" sets
       *     `{ tool: "list_layouts", reason: "fetch a layoutId first",
       *     autoExecute: true }` so the chat-runner pre-fetches the
       *     missing data and retries the original call without
       *     bothering the model.
       *   - `add_module_to_page` rejecting "block 'content' does not
       *     exist" sets `{ tool: "edit_template_blocks", args: {...},
       *     reason: "..." }` — not autoExecute (write op), but the AI
       *     sees the hint in its next-turn input and follows it.
       *
       * The chat-runner consumes `autoExecute: true` only when the
       * suggested tool is a read-only list/get; write recoveries always
       * surface to the AI for review. Auto-recovery is bounded to one
       * retry per original call to prevent loops.
       */
      readonly nextAction?: {
        /** Caelo tool name to call (e.g. `list_layouts`). The tool MUST
         * be registered in the chat-runner's catalogue OR the recovery
         * is silently skipped. */
        readonly tool: string;
        /** Suggested arguments. Omit to let the model fill them in. */
        readonly args?: Record<string, unknown>;
        /** Single-sentence human-readable explanation. Always rendered
         * to the AI verbatim after the failure message. */
        readonly reason: string;
        /** When true AND the suggested tool is read-only, the
         * chat-runner runs the recovery itself and retries the
         * original call once before yielding the failure. Defaults to
         * false (AI sees the hint and decides). */
        readonly autoExecute?: boolean;
        /**
         * v0.6.0 alpha.2 — declarative arg-rewriter. After the recovery
         * succeeds, the chat-runner extracts `recovery.value` at
         * `fromValuePath` (dot-separated; supports numeric indices) and
         * sets it as `argName` on the ORIGINAL tool's args, then
         * re-dispatches once. Eliminates the second AI round-trip the
         * AI would otherwise need to call list_X + read + retry with
         * corrected args.
         */
        readonly retryWithArgs?: {
          readonly argName: string;
          readonly fromValuePath: string;
        };
      };
    }
  /**
   * v0.5.0 — per-entity write lock rejected the write. The named entity
   * is held by another chat; caller must wait for that chat to publish
   * or discard, or pick a different target. AI surfaces this via the
   * tool-result so the operator sees who holds the lock.
   */
  | {
      readonly kind: "Locked";
      readonly operation: string;
      readonly message: string;
      readonly entityKind: string;
      readonly entityId: string;
      readonly holder: {
        readonly chatSessionId: string;
        readonly chatBranchId: string;
        readonly lockedAt: string;
      };
    }
  /**
   * issue #264 — a per-entity sub-lease rejected the write because a
   * SIBLING task on the SAME chat branch already holds the entity. Unlike
   * `Locked` (a different-chat conflict), this signals overlapping task
   * sets between parallel subagents — a disjointness violation. The AI
   * surfaces it so the offending subagent leaves the entity to its owner.
   */
  | {
      readonly kind: "SiblingLeaseConflict";
      readonly operation: string;
      readonly message: string;
      readonly entityKind: string;
      readonly entityId: string;
      readonly holder: {
        readonly holderKey: string;
        readonly expiresAt: string;
      };
    };

/**
 * Run #9 R8 — abort sentinel for multi-write op handlers.
 *
 * `runOperation` runs each handler inside ONE transaction, but drizzle
 * only rolls back on a THROW — a handler that `return err(...)` after
 * partial writes COMMITS those writes (run #9: a failed
 * `imports.compose_from_run` left 23 mangled pages behind). Handlers
 * that detect a failure AFTER their first write must `throw new
 * OperationAbortError(queryError)` instead of returning the err: the
 * adapter catches the sentinel, lets the transaction roll back, and
 * returns `err(queryError)` to the caller — same Result shape, zero
 * residue.
 *
 * Handlers that fail BEFORE any write (input/state validation) keep
 * returning `err(...)` values — that path also preserves any
 * `recordAudit(succeeded: false)` rows they wrote, which a rollback
 * would erase (CLAUDE.md §7: audit is not optional).
 */
export class OperationAbortError extends Error {
  readonly queryError: QueryError;

  constructor(queryError: QueryError) {
    super(
      queryError.kind === "HandlerError" ||
        queryError.kind === "Locked" ||
        queryError.kind === "SiblingLeaseConflict"
        ? queryError.message
        : queryError.kind,
    );
    this.name = "OperationAbortError";
    this.queryError = queryError;
  }
}

/**
 * Postgres error codes that mean "RLS denied the row" — either `USING` filtered
 * all rows (read attempts return empty — no error) or `WITH CHECK` rejected a
 * write (error code 42501 = insufficient_privilege).
 */
export const PG_INSUFFICIENT_PRIVILEGE = "42501";

/**
 * v0.5.17 — extract Postgres structured fields from a thrown SQL error.
 * Walks `.cause` (depth-limited) since drizzle wraps the bun-postgres
 * error and bun-postgres wraps the wire-level PG error. Returns the
 * first object that carries any of the recognized fields, or null when
 * the throw isn't a SQL-shaped error.
 *
 * Bun.SQL puts SQLSTATE on `.errno`; pg-style drivers use `.code`.
 * Both surface `.detail` / `.constraint` / `.table` / `.column` directly
 * on the Postgres error object.
 */
export function extractPgFields(error: unknown): {
  code?: string;
  constraint?: string;
  table?: string;
  column?: string;
  detail?: string;
} | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    const e = current as {
      code?: unknown;
      errno?: unknown;
      detail?: unknown;
      constraint?: unknown;
      table?: unknown;
      column?: unknown;
      cause?: unknown;
    };
    const code =
      typeof e.code === "string" ? e.code : typeof e.errno === "string" ? e.errno : undefined;
    const constraint = typeof e.constraint === "string" ? e.constraint : undefined;
    const table = typeof e.table === "string" ? e.table : undefined;
    const column = typeof e.column === "string" ? e.column : undefined;
    const detail = typeof e.detail === "string" ? e.detail : undefined;
    if (code || constraint || table || column || detail) {
      const out: {
        code?: string;
        constraint?: string;
        table?: string;
        column?: string;
        detail?: string;
      } = {};
      if (code) out.code = code;
      if (constraint) out.constraint = constraint;
      if (table) out.table = table;
      if (column) out.column = column;
      if (detail) out.detail = detail;
      return out;
    }
    current = e.cause;
  }
  return null;
}

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
