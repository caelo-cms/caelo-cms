// SPDX-License-Identifier: MPL-2.0

/**
 * The chat-scope stdio MCP server: `caelo_chat` plus its approval wait and
 * the image upload companion, bound to a stdio transport. The server itself
 * (tools, replies, approval waits) is ./surfaces/chat-surface.ts, shared
 * with the admin's remote endpoint (issue #806); this module backs it with
 * HTTP calls to the admin install's `/api/mcp/*` endpoints.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { resolveApprovalWaitMs } from "./approval-wait.js";
import { fetchChatApprovalState, resumeChat, sendChat } from "./chat-bridge.js";
import { resolveTimeoutMs } from "./http.js";
import { uploadImages } from "./image-upload.js";
import { createChatMcpServer } from "./surfaces/chat-surface.js";
import { ownVersion } from "./version-handshake.js";

export interface StartOpts {
  readonly adminUrl: string;
  readonly token: string;
  /** Defaults to stdio; tests pass an in-memory transport. */
  readonly transport?: Transport;
  /** Poll interval while waiting on an approval; tests shorten it. */
  readonly approvalPollMs?: number;
}

/** The resume request's timeout (`resumeChat`), reserved out of a call's budget. */
const resumeTimeoutMs = (): number => resolveTimeoutMs(30_000);

export async function startMcpServer(opts: StartOpts): Promise<void> {
  const target = { adminUrl: opts.adminUrl, token: opts.token };
  const server = createChatMcpServer(
    {
      sendChat: (input) =>
        sendChat({
          ...target,
          message: input.message,
          ...(input.attachments ? { attachments: input.attachments } : {}),
          ...(input.chatSessionId ? { chatSessionId: input.chatSessionId } : {}),
          ...(input.pageId ? { pageId: input.pageId } : {}),
        }),
      resumeChat: (chatSessionId) => resumeChat({ ...target, chatSessionId }),
      fetchChatApprovalState: (chatSessionId) =>
        fetchChatApprovalState({ ...target, chatSessionId }),
      uploadImages: (args) => uploadImages(target, args),
    },
    {
      serverVersion: ownVersion(),
      approvalWaitMs: resolveApprovalWaitMs,
      resumeTimeoutMs,
      ...(opts.approvalPollMs !== undefined ? { approvalPollMs: opts.approvalPollMs } : {}),
    },
  );
  await server.connect(opts.transport ?? new StdioServerTransport());
}
