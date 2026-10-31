// SPDX-License-Identifier: MPL-2.0

/**
 * #1268 — per-step durations of a request as a `Server-Timing` header.
 *
 * The browser's network panel shows them, and they ride the response,
 * so a slow step of a page load is named where the request is (Cloud Run
 * request logs, the operator's devtools) instead of only as one long
 * latency. Steps that stream after the headers left cannot be in the
 * header; the load logs those instead (see `SLOW_STEP_MS`).
 */

/** A streamed step slower than this is logged with its name and duration. */
export const SLOW_STEP_MS = 2000;

/** Collects named step durations for one request. */
export class ServerTiming {
  readonly #entries: { name: string; ms: number }[] = [];

  /** Runs `step` and records its duration under `name`. */
  async time<T>(name: string, step: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await step();
    } finally {
      this.#entries.push({ name, ms: performance.now() - started });
    }
  }

  /** The `Server-Timing` header value, in the order the steps finished. */
  header(): string {
    return this.#entries
      .map(({ name, ms }) => `${headerToken(name)};dur=${ms.toFixed(1)}`)
      .join(", ");
  }
}

/** A step name as a header token (RFC 9110 `token`: no spaces, no separators). */
function headerToken(name: string): string {
  return name.replace(/[^A-Za-z0-9!#$%&'*+.^_`|~-]/g, "_");
}
