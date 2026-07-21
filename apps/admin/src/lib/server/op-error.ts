// SPDX-License-Identifier: MPL-2.0

/**
 * Surface a user-facing message from a failed `execute()` Result. `HandlerError`
 * / `Locked` / `SiblingLeaseConflict` carry a human `message` (e.g. a password
 * strength reason or "this reset link has expired"); the shape-level failures
 * (validation, actor-scope, rate-limit) don't, so those fall back to `fallback`.
 */
export function opErrorMessage(error: unknown, fallback: string): string {
  const message = (error as { message?: unknown } | null | undefined)?.message;
  return typeof message === "string" && message.length > 0 ? message : fallback;
}
