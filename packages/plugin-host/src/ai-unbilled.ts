// SPDX-License-Identifier: MPL-2.0

/**
 * #1653 — when a failed AI call may give its reservation back.
 *
 * A reservation is the call's worst case, booked before it runs. When the
 * call fails, missing usage is no evidence that nothing was billed: a
 * timeout, an abort or a connection lost after the request went out may
 * come after the provider read the prompt and generated part of the answer.
 * So a failure gives the reservation back only when it proves the provider
 * billed nothing, and every other failure keeps it: spend is overstated,
 * never under, and the reservation ages out of the rolling budgets.
 *
 * Three answers prove it (read from the AI SDK's own error types, CLAUDE.md
 * §12):
 * - the provider answered with an error status (`APICallError` with a 4xx or
 *   5xx), which means it refused the request instead of generating;
 * - the SDK refused the request before sending it (an invalid prompt or
 *   argument, a feature the model does not offer);
 * - no connection to the provider ever opened (refused, host not found).
 *
 * A `RetryError` proves it only when every one of its attempts does.
 */

import {
  APICallError,
  InvalidArgumentError,
  InvalidPromptError,
  RetryError,
  UnsupportedFunctionalityError,
} from "ai";

/** Connection failures that happen before a request can leave (Node and Bun spellings). */
const NEVER_CONNECTED = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ConnectionRefused",
  "FailedToOpenSocket",
]);

/** Deep enough for an SDK error wrapping a fetch error wrapping a socket error. */
const MAX_DEPTH = 6;

/**
 * Whether this failure of a provider call proves that the provider billed
 * nothing. False for anything that may have been billed, including errors
 * this function does not know.
 *
 * @example
 * if (failureProvedUnbilled(e)) await release(callId);
 * else await settleKeepingReservation(callId, knownUsage);
 */
export function failureProvedUnbilled(error: unknown): boolean {
  return proved(error, 0);
}

function proved(error: unknown, depth: number): boolean {
  if (error === null || error === undefined || depth > MAX_DEPTH) return false;
  if (RetryError.isInstance(error)) {
    return error.errors.length > 0 && error.errors.every((e) => proved(e, depth + 1));
  }
  if (APICallError.isInstance(error)) {
    if (typeof error.statusCode === "number") return error.statusCode >= 400;
    return neverConnected(error.cause, depth + 1);
  }
  if (
    InvalidPromptError.isInstance(error) ||
    InvalidArgumentError.isInstance(error) ||
    UnsupportedFunctionalityError.isInstance(error)
  ) {
    return true;
  }
  return neverConnected(error, depth);
}

/** A socket error that says the connection was never made, anywhere in the cause chain. */
function neverConnected(error: unknown, depth: number): boolean {
  let current: unknown = error;
  for (let d = depth; d <= MAX_DEPTH && typeof current === "object" && current !== null; d++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && NEVER_CONNECTED.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
