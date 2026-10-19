// SPDX-License-Identifier: MPL-2.0

/**
 * The chat-scope MCP server (`caelo_chat`, `caelo_await_approval`,
 * `caelo_upload_images`), independent of how it reaches Caelo. The stdio
 * shim backs it with HTTP calls to `/api/mcp/*` (../server.ts); the admin's
 * remote endpoint `/api/mcp/remote/chat` backs it with the same `mcp.*` ops
 * in-process (issue #806). Both therefore show an agent the same tools and
 * the same replies, approval waits included.
 *
 * Routing edits through one conversational tool is deliberate: the remote
 * agent talks to Caelo's chat-runner the same way a human in the browser
 * does — same auth surface, same actor scope, same audit trail.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  type ChatApprovalState,
  describeDecisions,
  describeReady,
  describeSuperseded,
  describeWaiting,
  type SendChatResult,
  type SettleResult,
  settleChatApprovals,
} from "../chat-approval.js";
import {
  CAELO_CHAT_TOOL,
  type CaeloChatInput,
  CHAT_AWAIT_APPROVAL_TOOL,
  CHAT_MCP_INSTRUCTIONS,
  CHAT_TOOLS,
  caeloChatInputSchema,
  chatAwaitApprovalInput,
  UPLOAD_IMAGES_TOOL,
} from "../tool-definitions.js";

/** What the chat surface needs from Caelo — HTTP for the shim, ops in the admin. */
export interface ChatSurfaceBackend {
  sendChat(input: CaeloChatInput): Promise<SendChatResult>;
  /** Issue #658 — resume this agent's paused turn with the operator's decisions. */
  resumeChat(chatSessionId: string): Promise<SendChatResult>;
  /** Issue #658 — the operator's decisions on this agent's paused turn (read-only). */
  fetchChatApprovalState(chatSessionId: string): Promise<ChatApprovalState>;
  uploadImages(args: unknown): Promise<CallToolResult>;
}

export interface ChatSurfaceOptions {
  /**
   * serverInfo.version — the release this server belongs to (#841): the
   * package's own version for the stdio bins, CAELO_VERSION for the admin's
   * remote endpoint. Required so no surface reports a made-up version.
   */
  readonly serverVersion: string;
  /** The caelo_upload_images definition (local vs remote description). */
  readonly uploadImagesTool?: { name: string; description: string; inputSchema: object };
  /** The bounded wait on the operator (read per call). */
  readonly approvalWaitMs: () => number;
  /** Time a resume may take; reserved out of a call's budget. */
  readonly resumeTimeoutMs: () => number;
  /** Poll interval while waiting on an approval; tests shorten it. */
  readonly approvalPollMs?: number;
}

/** Headroom for the state reads around a resume in caelo_await_approval. */
const RESUME_SLACK_MS = 5_000;

/**
 * The tool result for a caelo_chat exchange: every reply in order (the first
 * turn, then each resumed one), the decisions in between, and — while cards
 * still wait — the next step.
 */
function chatResult(
  first: SendChatResult | null,
  settled: SettleResult,
  chatSessionId: string,
): CallToolResult & { content: Array<{ type: "text"; text: string }> } {
  const turns = first ? [first, ...settled.turns] : [...settled.turns];
  const last = turns.at(-1);
  const text = [
    ...(first ? [first.assistant] : []),
    ...(settled.decided.length > 0 ? [describeDecisions(settled.decided)] : []),
    ...settled.turns.map((t) => t.assistant),
    ...(settled.kind === "pending" ? [describeWaiting(chatSessionId, settled.waiting)] : []),
    ...(settled.kind === "superseded" ? [describeSuperseded(settled.dropped)] : []),
    ...(settled.kind === "ready" ? [describeReady(chatSessionId)] : []),
  ]
    .filter((t) => t.trim().length > 0)
    .join("\n\n");
  const reply =
    text.length > 0
      ? text
      : "Nothing of yours waits for the operator's approval in this chat; continue with caelo_chat.";
  return {
    content: [
      { type: "text" as const, text: reply },
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            chatSessionId,
            requestId: last?.requestId ?? null,
            toolCalls: turns.flatMap((t) => t.toolCalls),
            pendingProposals: last?.pendingProposals ?? 0,
            costMicrocents: turns.reduce((sum, t) => sum + t.costMicrocents, 0),
            // Non-empty while the turn waits on the operator.
            pendingApprovals:
              settled.kind === "pending"
                ? settled.waiting.map((a) => ({ approvalId: a.approvalId, toolName: a.toolName }))
                : [],
          },
          null,
          2,
        ),
      },
    ],
  };
}

/** Build the chat-scope MCP server over `backend`. The caller connects a transport. */
export function createChatMcpServer(backend: ChatSurfaceBackend, opts: ChatSurfaceOptions): Server {
  const uploadTool = opts.uploadImagesTool ?? UPLOAD_IMAGES_TOOL;
  const server = new Server(
    { name: "caelo-mcp-server", version: opts.serverVersion },
    { capabilities: { tools: {} }, instructions: CHAT_MCP_INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: CHAT_TOOLS.map((t) => (t === UPLOAD_IMAGES_TOOL ? uploadTool : t)),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra): Promise<CallToolResult> => {
    // Progress notifications keep progress-aware clients from timing the
    // call out while it waits on the operator (only when they asked).
    const progressToken = req.params._meta?.progressToken;
    const onPending =
      progressToken === undefined
        ? undefined
        : async (elapsedMs: number) => {
            await extra.sendNotification({
              method: "notifications/progress",
              params: {
                progressToken,
                progress: Math.round(elapsedMs / 1000),
                message: "Waiting for the operator to approve or reject in the Caelo admin…",
              },
            });
          };
    /** Wait for the operator, then continue the paused turn (issue #658). */
    const settle = (chatSessionId: string, waitMs: number) =>
      settleChatApprovals({
        chatSessionId,
        fetchState: () => backend.fetchChatApprovalState(chatSessionId),
        resume: () => backend.resumeChat(chatSessionId),
        waitMs,
        // The resume's whole timeout stays inside the call's budget.
        resumeReserveMs: opts.resumeTimeoutMs(),
        ...(opts.approvalPollMs !== undefined ? { intervalMs: opts.approvalPollMs } : {}),
        ...(onPending ? { onPending } : {}),
      });

    if (req.params.name === uploadTool.name) {
      try {
        return await backend.uploadImages(req.params.arguments);
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: String(e) }] };
      }
    }
    if (req.params.name === CHAT_AWAIT_APPROVAL_TOOL.name) {
      const parsed = chatAwaitApprovalInput.safeParse(req.params.arguments ?? {});
      if (!parsed.success) {
        return {
          isError: true,
          content: [{ type: "text", text: `invalid arguments: ${parsed.error.message}` }],
        };
      }
      try {
        // Room for at least one resume, even with a short configured wait —
        // otherwise a decided turn could never continue.
        const settled = await settle(
          parsed.data.chatSessionId,
          Math.max(opts.approvalWaitMs(), opts.resumeTimeoutMs() + RESUME_SLACK_MS),
        );
        return chatResult(null, settled, parsed.data.chatSessionId);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          isError: true,
          content: [{ type: "text", text: `caelo_await_approval failed: ${msg}` }],
        };
      }
    }
    if (req.params.name !== CAELO_CHAT_TOOL.name) {
      return {
        isError: true,
        content: [{ type: "text", text: `unknown tool: ${req.params.name}` }],
      };
    }
    const parsed = caeloChatInputSchema.safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      return {
        isError: true,
        content: [{ type: "text", text: `invalid arguments: ${parsed.error.message}` }],
      };
    }
    try {
      const startedAt = Date.now();
      const result = await backend.sendChat(parsed.data);
      // Issue #658 — the turn paused on approval cards: wait for the
      // operator's decision within what is left of the wait bound, then
      // continue this same turn and return its reply too.
      if (result.pendingApprovals.length === 0) {
        return chatResult(
          result,
          { kind: "settled", decided: [], turns: [] },
          result.chatSessionId,
        );
      }
      let settled: SettleResult;
      try {
        settled = await settle(
          result.chatSessionId,
          Math.max(0, opts.approvalWaitMs() - (Date.now() - startedAt)),
        );
      } catch (e) {
        // The turn ran and its session exists: keep both in the result so
        // the agent can continue with caelo_await_approval instead of
        // retrying into duplicate work (codex review).
        const msg = e instanceof Error ? e.message : String(e);
        const waiting = chatResult(
          result,
          {
            kind: "pending",
            decided: [],
            turns: [],
            waiting: result.pendingApprovals.map((a) => ({
              ...a,
              status: "pending" as const,
              approved: null,
              reason: null,
            })),
          },
          result.chatSessionId,
        );
        return {
          ...waiting,
          content: [
            ...waiting.content,
            {
              type: "text" as const,
              text: `Checking the operator's decision failed (${msg}); the request still exists. Call caelo_await_approval with chatSessionId "${result.chatSessionId}".`,
            },
          ],
        };
      }
      return chatResult(result, settled, result.chatSessionId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        isError: true,
        content: [{ type: "text", text: `caelo_chat failed: ${msg}` }],
      };
    }
  });

  return server;
}
