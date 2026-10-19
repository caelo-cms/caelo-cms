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

import type { z } from "zod";
import type { ChatApprovalState, SendChatResult } from "./chat-approval.js";
import { postAdmin, resolveTimeoutMs } from "./http.js";
import type { uploadedImageSchema } from "./tool-definitions.js";

interface AdminTarget {
  readonly adminUrl: string;
  readonly token: string;
}

export interface SendChatOpts extends AdminTarget {
  readonly message: string;
  readonly attachments?: z.infer<typeof uploadedImageSchema>[];
  readonly chatSessionId?: string;
  readonly pageId?: string;
}

export async function sendChat(opts: SendChatOpts): Promise<SendChatResult> {
  return postAdmin<SendChatResult>({
    adminUrl: opts.adminUrl,
    token: opts.token,
    path: "/api/mcp/chat",
    body: {
      message: opts.message,
      attachments: opts.attachments,
      chatSessionId: opts.chatSessionId,
      pageId: opts.pageId,
    },
    timeoutMs: resolveTimeoutMs(30_000),
  });
}

/**
 * Issue #658 — resume this token's paused turn once the operator decided
 * every approval card of it. The reply is the resumed turn's.
 */
export async function resumeChat(
  opts: AdminTarget & { readonly chatSessionId: string },
): Promise<SendChatResult> {
  return postAdmin<SendChatResult>({
    adminUrl: opts.adminUrl,
    token: opts.token,
    path: "/api/mcp/chat",
    body: { chatSessionId: opts.chatSessionId, resumeApprovals: true },
    timeoutMs: resolveTimeoutMs(30_000),
  });
}

/** Issue #658 — the operator's decisions on this token's paused turn (read-only). */
export async function fetchChatApprovalState(
  opts: AdminTarget & { readonly chatSessionId: string },
): Promise<ChatApprovalState> {
  return postAdmin<ChatApprovalState>({
    adminUrl: opts.adminUrl,
    token: opts.token,
    path: "/api/mcp/chat/approval",
    body: { chatSessionId: opts.chatSessionId },
    timeoutMs: resolveTimeoutMs(30_000),
  });
}
