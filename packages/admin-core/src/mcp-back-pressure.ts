// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1375 — MCP back-pressure: when this admin instance's database pool
 * is saturated, an MCP request is answered at once with 429 and
 * `Retry-After` instead of joining the queue.
 *
 * Why only MCP: an external agent can wait and send the same call again,
 * and it is the traffic that grows without bound (every parallel agent
 * session adds its own stream of tool calls). The editor's own requests,
 * the chat and the workers keep queueing for the pool deadline as before.
 * Production, 2026-11-03: up to ten Power-MCP sessions ran against one
 * admin while slow reads held its connections. Each new call waited the
 * 10 s acquire deadline, failed with a 500, and was sent again, so the
 * queue never drained and every session — reads included — failed for
 * 30–45 minutes. Refusing early frees the pool for the calls already
 * running and gives the agents a clear "wait N s" instead of a 500.
 *
 * Nothing is refused while the pool has room: a request is turned away
 * only while callers are already waiting for a connection, and only once
 * the oldest of them has waited {@link MCP_SATURATION_WAIT_MS} (a burst of
 * parallel calls that is served within a second is normal) or as many
 * callers wait as the pool has connections.
 */

import { POOL_BUSY_RETRY_AFTER_MS, type PoolPressure, type QueryError } from "@caelo-cms/query-api";

/** How long the oldest waiter must have waited before MCP calls are refused. */
export const MCP_SATURATION_WAIT_MS = 1_000;

/** The longest `Retry-After` the gate asks for. */
export const MCP_MAX_RETRY_AFTER_SECONDS = 30;

/** How often a refusal is logged with the pool's holders (one line per window). */
const LOG_EVERY_MS = 30_000;

/** Whether to refuse, and for how long the caller should wait. */
export type McpBackPressureVerdict =
  | { readonly busy: false }
  | { readonly busy: true; readonly retryAfterSeconds: number };

/**
 * Decide from a pool snapshot whether an MCP request is refused. The wait
 * asked for grows with how long callers already wait (a queue that has not
 * moved for 12 s will not be free in 5), from the pool's own retry hint up
 * to {@link MCP_MAX_RETRY_AFTER_SECONDS}.
 */
export function mcpBackPressure(pressure: PoolPressure): McpBackPressureVerdict {
  if (pressure.waiting === 0) return { busy: false };
  const saturated =
    pressure.oldestWaitMs >= MCP_SATURATION_WAIT_MS || pressure.waiting >= pressure.max;
  if (!saturated) return { busy: false };
  const seconds = Math.ceil(Math.max(POOL_BUSY_RETRY_AFTER_MS, pressure.oldestWaitMs) / 1000);
  return { busy: true, retryAfterSeconds: Math.min(MCP_MAX_RETRY_AFTER_SECONDS, seconds) };
}

/** What the agent reads: the call did not run, wait, then send it again unchanged. */
export function mcpBusyMessage(retryAfterSeconds: number): string {
  return (
    `Caelo is at capacity right now: every database connection of this admin instance is in use, so this call was not run and nothing was changed. ` +
    `Wait ${retryAfterSeconds} s, then send the same call again unchanged. ` +
    "Parallel sessions are fine; if this keeps happening, let fewer of them call at the same moment."
  );
}

/**
 * The 429 for a refused MCP request. The remote MCP endpoints speak
 * JSON-RPC, so their body is a JSON-RPC error the client shows to the
 * agent; the local bridge's endpoints get `{ message }`.
 */
export function mcpBusyResponse(pathname: string, retryAfterSeconds: number): Response {
  const message = mcpBusyMessage(retryAfterSeconds);
  const body = pathname.startsWith("/api/mcp/remote/")
    ? {
        jsonrpc: "2.0",
        error: { code: -32000, message, data: { retryAfterSeconds } },
        id: null,
      }
    : { message, retryAfterSeconds };
  return new Response(JSON.stringify(body), {
    status: 429,
    headers: {
      "content-type": "application/json",
      "retry-after": String(retryAfterSeconds),
      "cache-control": "no-store",
    },
  });
}

/**
 * The 429 for an op that failed because the admin's database pool was
 * exhausted (`busy`), or null for any other failure. An MCP route checks it
 * before mapping the failure to 4xx/500: a busy pool is load, and the agent
 * should wait and send the same call again, not read a 500.
 */
export function mcpBusyFailureResponse(e: QueryError, pathname: string): Response | null {
  if (e.kind !== "HandlerError" || e.busy === undefined) return null;
  const seconds = Math.min(MCP_MAX_RETRY_AFTER_SECONDS, Math.ceil(e.busy.retryAfterMs / 1000));
  return mcpBusyResponse(pathname, seconds);
}

let lastLoggedAt = 0;

/**
 * The gate: null when the request may proceed, else the 429 to answer.
 * Logs a refusal with the pool's longest holders once per window, so the
 * server log names what kept the connections (the pool error's promise).
 */
export function mcpBackPressureResponse(
  pathname: string,
  pressure: PoolPressure,
  now: number = Date.now(),
): Response | null {
  if (!pathname.startsWith("/api/mcp/")) return null;
  const verdict = mcpBackPressure(pressure);
  if (!verdict.busy) return null;
  if (now - lastLoggedAt >= LOG_EVERY_MS) {
    lastLoggedAt = now;
    console.warn("[mcp] back-pressure: the admin database pool is saturated; MCP calls get 429", {
      inUse: pressure.inUse,
      max: pressure.max,
      waiting: pressure.waiting,
      oldestWaitMs: pressure.oldestWaitMs,
      retryAfterSeconds: verdict.retryAfterSeconds,
      holders: pressure.holders.slice(0, 10),
    });
  }
  return mcpBusyResponse(pathname, verdict.retryAfterSeconds);
}
