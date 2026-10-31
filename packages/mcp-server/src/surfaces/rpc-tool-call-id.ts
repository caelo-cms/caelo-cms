// SPDX-License-Identifier: MPL-2.0

import { createHash } from "node:crypto";

/**
 * #1253 — the idempotency key of an MCP tool call: one per (session key,
 * JSON-RPC request id) — the remote transport session, or the stdio
 * process. Hashed over an unambiguous encoding of both, so a long id is never truncated into another call's
 * key and the numeric id `1` is not the string id `"1"` (JSON-RPC allows
 * both) — a collision would hand a new call the first one's cached result.
 *
 * @returns `rpc-` and 64 hex characters (fits the 128-character key).
 */
export function rpcToolCallId(sessionKey: string, rpcRequestId: string | number): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([sessionKey, rpcRequestId]))
    .digest("hex");
  return `rpc-${digest}`;
}
