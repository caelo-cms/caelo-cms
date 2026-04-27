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
  const e = error as { kind?: string; message?: string; issues?: unknown[]; detail?: string };
  if (e.kind === "ValidationFailed" && Array.isArray(e.issues)) {
    return `validation: ${e.issues
      .slice(0, 3)
      .map((i) => {
        const z = i as { path?: unknown[]; message?: string };
        return `${(z.path ?? []).join(".")}: ${z.message ?? "?"}`;
      })
      .join("; ")}`;
  }
  if (typeof e.message === "string") return e.message;
  if (typeof e.detail === "string") return e.detail;
  return e.kind ?? "unknown";
}
