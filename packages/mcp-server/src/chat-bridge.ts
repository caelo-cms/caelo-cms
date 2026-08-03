// SPDX-License-Identifier: MPL-2.0

/**
 * HTTP bridge — translates a `caelo_chat` MCP call into a single POST
 * against the admin install's `/api/mcp/chat` endpoint. The endpoint
 * dispatches `mcp.send_chat` (system-only op) which resolves the
 * bearer to a Caelo actor and drives `runChatTurn`.
 *
 * 30-second default client-side timeout (override with
 * `CAELO_MCP_TIMEOUT_MS`) — chat-runner turns longer than that are
 * likely stuck (the runner has its own provider-call timeouts). MCP
 * clients see a clean error instead of a hung connection.
 */

import { postAdmin, resolveTimeoutMs } from "./http.js";

export interface SendChatOpts {
  readonly adminUrl: string;
  readonly token: string;
  readonly message: string;
  readonly chatSessionId?: string;
  readonly pageId?: string;
}

export interface SendChatResult {
  readonly chatSessionId: string;
  readonly requestId: string;
  readonly assistant: string;
  readonly toolCalls: ReadonlyArray<{ name: string; summary: string; succeeded: boolean }>;
  readonly pendingProposals: number;
  readonly costMicrocents: number;
}

export async function sendChat(opts: SendChatOpts): Promise<SendChatResult> {
  return postAdmin<SendChatResult>({
    adminUrl: opts.adminUrl,
    token: opts.token,
    path: "/api/mcp/chat",
    body: {
      message: opts.message,
      chatSessionId: opts.chatSessionId,
      pageId: opts.pageId,
    },
    timeoutMs: resolveTimeoutMs(30_000),
  });
}
