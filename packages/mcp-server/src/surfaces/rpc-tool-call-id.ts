// SPDX-License-Identifier: MPL-2.0

import { createHash } from "node:crypto";

/** The call a `tools/call` asks for: the tool and its arguments. */
export interface RpcToolCall {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
}

/**
 * #1253 — the idempotency key of an MCP tool call: one per (session key,
 * JSON-RPC request id) — the remote transport session, or the stdio
 * process — AND per call. Hashed over an unambiguous encoding of all of
 * them, so a long id is never truncated into another call's key and the
 * numeric id `1` is not the string id `"1"` (JSON-RPC allows both) — a
 * collision would hand a new call the first one's cached result.
 *
 * #1704 — the call is part of the key because a client may send a JSON-RPC
 * id again for a different call: one that reconnects with its
 * `Mcp-Session-Id` counts its ids from 0 again, and each of its calls was
 * answered with the result of the earlier call under the same id. With the
 * call in the key, a reused id with another call is a new call; a resend of
 * the same request (same id, same call) still gets the first result. The
 * arguments' object keys are sorted, so the key does not depend on the order
 * a client serialised them in.
 *
 * @returns `rpc-` and 64 hex characters (fits the 128-character key).
 */
export function rpcToolCallId(
  sessionKey: string,
  rpcRequestId: string | number,
  call: RpcToolCall,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([sessionKey, rpcRequestId, call.toolName, sortKeys(call.args)]))
    .digest("hex");
  return `rpc-${digest}`;
}

/** `value` with every object's keys in sorted order; arrays keep theirs. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((k) => [k, sortKeys(record[k])]),
    );
  }
  return value;
}
