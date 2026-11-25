// SPDX-License-Identifier: MPL-2.0

/**
 * #1653 — only a failure that proves the provider billed nothing gives a
 * reservation back. Each case is the AI SDK's own error type, as a real
 * call surfaces it.
 */

import { describe, expect, it } from "bun:test";
import { APICallError, InvalidPromptError, RetryError } from "ai";
import { failureProvedUnbilled } from "./ai-unbilled.js";

const apiError = (statusCode: number | undefined, cause?: unknown) =>
  new APICallError({
    message: statusCode === undefined ? "Cannot connect to API" : `status ${statusCode}`,
    url: "https://provider.test/v1/messages",
    requestBodyValues: {},
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(cause !== undefined ? { cause } : {}),
  });

const socket = (code: string) => Object.assign(new Error(`socket: ${code}`), { code });

describe("failureProvedUnbilled", () => {
  it("an error status from the provider proves it: it refused instead of generating", () => {
    expect(failureProvedUnbilled(apiError(400))).toBe(true);
    expect(failureProvedUnbilled(apiError(429))).toBe(true);
    expect(failureProvedUnbilled(apiError(529))).toBe(true);
  });

  it("a request the SDK refused to send proves it", () => {
    expect(failureProvedUnbilled(new InvalidPromptError({ prompt: [], message: "empty" }))).toBe(
      true,
    );
  });

  it("a connection that never opened proves it; one lost after sending does not", () => {
    expect(failureProvedUnbilled(apiError(undefined, socket("ECONNREFUSED")))).toBe(true);
    expect(failureProvedUnbilled(apiError(undefined, socket("ConnectionRefused")))).toBe(true);
    expect(
      failureProvedUnbilled(new TypeError("fetch failed", { cause: socket("ENOTFOUND") })),
    ).toBe(true);
    expect(failureProvedUnbilled(apiError(undefined, socket("ECONNRESET")))).toBe(false);
    expect(failureProvedUnbilled(apiError(undefined))).toBe(false);
  });

  it("a retry proves it only when every attempt does", () => {
    const retry = (errors: unknown[]) =>
      new RetryError({ message: "retries exhausted", reason: "maxRetriesExceeded", errors });
    expect(failureProvedUnbilled(retry([apiError(529), apiError(529)]))).toBe(true);
    expect(failureProvedUnbilled(retry([apiError(529), new Error("timed out")]))).toBe(false);
    expect(failureProvedUnbilled(retry([]))).toBe(false);
  });

  it("an abort, a timeout or an unknown error keeps the reservation", () => {
    expect(failureProvedUnbilled(new DOMException("aborted", "AbortError"))).toBe(false);
    expect(failureProvedUnbilled(new Error("The operation timed out."))).toBe(false);
    expect(failureProvedUnbilled("overloaded")).toBe(false);
    expect(failureProvedUnbilled(null)).toBe(false);
  });
});
