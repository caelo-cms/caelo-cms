// SPDX-License-Identifier: MPL-2.0

/**
 * Shared error-string helper for AI tools. Turns a Query API
 * `QueryError` into a single human-readable line the AI can surface
 * back to the user. Picks out the ZodError issues for ValidationFailed
 * (path: message), the .message field for HandlerError, the .detail
 * for RLSDenied. Keeps the AI from saying "unknown error" when the
 * underlying op had a specific reason.
 */

export function describeError(error: unknown): string {
  if (!error || typeof error !== "object") return "unknown";
  const e = error as {
    kind?: string;
    message?: string;
    issues?: unknown[];
    detail?: string;
    pgDetail?: {
      code?: string;
      constraint?: string;
      table?: string;
      column?: string;
      detail?: string;
    };
  };
  if (e.kind === "ValidationFailed" && Array.isArray(e.issues)) {
    return `validation: ${e.issues
      .slice(0, 3)
      .map((i) => {
        const z = i as { path?: unknown[]; message?: string };
        return `${(z.path ?? []).join(".")}: ${z.message ?? "?"}`;
      })
      .join("; ")}`;
  }
  // v0.5.17 — adapter now extracts Postgres structured fields and
  // attaches them as `pgDetail` on the HandlerError. When present,
  // surface that as the primary message — it's the actual reason
  // for the SQL throw (SQLSTATE + constraint + detail), not the
  // truncated query text.
  if (e.pgDetail) {
    const parts: string[] = [];
    if (e.pgDetail.code) parts.push(`SQLSTATE ${e.pgDetail.code}`);
    if (e.pgDetail.constraint) parts.push(`constraint=${e.pgDetail.constraint}`);
    if (e.pgDetail.table) parts.push(`table=${e.pgDetail.table}`);
    if (e.pgDetail.column) parts.push(`column=${e.pgDetail.column}`);
    if (e.pgDetail.detail) parts.push(e.pgDetail.detail);
    if (parts.length > 0) return parts.join(" — ").slice(0, 240);
  }
  // v0.5.16 — fallback: when the message contains Bun.SQL's "Failed
  // query:" wrapper but pgDetail wasn't populated (caller built their
  // own HandlerError without going through the adapter), walk the cause
  // chain locally.
  const message = typeof e.message === "string" ? e.message : null;
  if (message && message.startsWith("Failed query")) {
    const pgDetail = extractPgDetail(error);
    if (pgDetail) return pgDetail;
  }
  if (message) return message;
  if (typeof e.detail === "string") return e.detail;
  return e.kind ?? "unknown";
}

/**
 * Walk a Bun.SQL / drizzle error chain looking for the underlying
 * PostgreSQL detail. The shape varies by driver:
 *   - bun-postgres: error.code (SQLSTATE), error.detail, error.constraint,
 *     error.message (sometimes carries "violates foreign key constraint")
 *   - drizzle: wraps the above as error.cause
 * Returns a compact one-liner — e.g.
 *   "FK violation: page_snapshots_page_id_fkey (Key (page_id)=(…) is not present in table pages)"
 */
function extractPgDetail(error: unknown, depth = 0): string | null {
  if (!error || typeof error !== "object" || depth > 4) return null;
  const e = error as {
    code?: string;
    errno?: string;
    detail?: string;
    constraint?: string;
    table?: string;
    column?: string;
    message?: string;
    cause?: unknown;
  };
  const sqlstate = e.code ?? e.errno ?? null;
  const msg = typeof e.message === "string" ? e.message : "";
  const hasPgSignal =
    sqlstate !== null ||
    (typeof e.detail === "string" && e.detail.length > 0) ||
    typeof e.constraint === "string" ||
    msg.includes("violates") ||
    msg.includes("constraint");
  if (hasPgSignal) {
    const parts: string[] = [];
    if (sqlstate) parts.push(`SQLSTATE ${sqlstate}`);
    if (e.constraint) parts.push(`constraint=${e.constraint}`);
    if (e.table) parts.push(`table=${e.table}`);
    if (e.column) parts.push(`column=${e.column}`);
    if (typeof e.detail === "string" && e.detail.length > 0) parts.push(e.detail);
    if (parts.length === 0 && msg && !msg.startsWith("Failed query")) {
      // Last resort: take the first non-Failed-query line of msg.
      const firstLine = msg.split("\n").find((l) => l && !l.startsWith("Failed query")) ?? msg;
      return firstLine.slice(0, 240);
    }
    if (parts.length > 0) return parts.join(" — ").slice(0, 240);
  }
  return extractPgDetail(e.cause, depth + 1);
}
