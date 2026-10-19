// SPDX-License-Identifier: MPL-2.0

/**
 * MCP server construction. Registers `caelo_chat` and the image upload companion
 * and binds it to a stdio transport. Routing edits through one conversational tool is
 * deliberate: the remote agent talks to Caelo's chat-runner the same
 * way a human in the browser does. Browse / publish / propose actions
 * happen through the chat ("which pages exist?" → agent calls
 * pages.list internally → text response). Same auth surface, same
 * actor scope, same audit trail.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { resolveApprovalWaitMs } from "./approval-wait.js";
import {
  describeDecisions,
  describeReady,
  describeSuperseded,
  describeWaiting,
  type SendChatResult,
  type SettleResult,
  settleChatApprovals,
} from "./chat-approval.js";
import { fetchChatApprovalState, resumeChat, sendChat } from "./chat-bridge.js";
import { resolveTimeoutMs } from "./http.js";
import { UPLOAD_IMAGES_TOOL, uploadedImageSchema, uploadImages } from "./image-upload.js";
import { ownVersion } from "./version-handshake.js";

export interface StartOpts {
  readonly adminUrl: string;
  readonly token: string;
  /** Defaults to stdio; tests pass an in-memory transport. */
  readonly transport?: Transport;
  /** Poll interval while waiting on an approval; tests shorten it. */
  readonly approvalPollMs?: number;
}

/**
 * MCP `instructions` for the chat-scope server (#552), injected into the
 * connecting agent's context so it uses caelo_chat as a conversation with
 * the site's own agent rather than a one-shot command.
 */
export const CHAT_MCP_INSTRUCTIONS = [
  "This server talks to a Caelo CMS site's own AI agent through caelo_chat; describe the outcome you want and the agent decides how to build it.",
  "Pass the chatSessionId from a reply to continue the same conversation; omit it only to start a new one.",
  "Changes land on that chat's preview branch; nothing reaches the live site until the operator publishes in the Caelo admin. Some actions wait for the operator's approval click there.",
  "When a reply says the turn is waiting for the operator's approval, call caelo_await_approval with the chatSessionId: it waits for the decision and returns your turn's continuation. Never re-send the request; you cannot approve anything yourself.",
].join("\n");

const awaitApprovalInput = z.object({ chatSessionId: z.string().uuid() }).strict();

/** The resume request's timeout (`resumeChat`), reserved out of a call's budget. */
const resumeTimeoutMs = (): number => resolveTimeoutMs(30_000);
/** Headroom for the state reads around a resume in caelo_await_approval. */
const RESUME_SLACK_MS = 5_000;

/** Issue #658 — keep waiting on the approval cards a caelo_chat turn paused on. */
const AWAIT_APPROVAL_TOOL = {
  name: "caelo_await_approval",
  description:
    "Wait for the operator's Approve/Reject on the approval cards your caelo_chat turn paused on, then " +
    "continue that turn and return its reply (the change applied, or the agent's reaction to a rejection). " +
    "Use it when a caelo_chat reply says it is still waiting for approval. You cannot approve anything " +
    "yourself — only the operator can, in the Caelo admin.",
  inputSchema: {
    type: "object",
    properties: {
      chatSessionId: {
        type: "string",
        description: "The chatSessionId from the caelo_chat reply that is waiting.",
      },
    },
    required: ["chatSessionId"],
  },
} as const;

/**
 * The tool result for a caelo_chat exchange: every reply in order (the first
 * turn, then each resumed one), the decisions in between, and — while cards
 * still wait — the next step.
 */
function chatResult(first: SendChatResult | null, settled: SettleResult, chatSessionId: string) {
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

const CHAT_TOOL = {
  name: "caelo_chat",
  description:
    "Talk to your Caelo CMS install's AI agent. Same agent that powers the live-edit chat overlay — it can read pages, propose edits, queue Owner-approval proposals, summarise plugin data. Continues an existing chat session (when chatSessionId is supplied) or starts a fresh one. Returns the agent's reply text plus structured tool-call summaries.",
  inputSchema: {
    type: "object",
    required: ["message"],
    properties: {
      attachments: {
        type: "array",
        maxItems: 4,
        description: "Attachments returned by caelo_upload_images.",
        items: z.toJSONSchema(uploadedImageSchema),
      },
      message: {
        type: "string",
        description: "What you want to say to the Caelo agent.",
      },
      chatSessionId: {
        type: "string",
        description:
          "Optional. Chat session UUID to continue. Omit to start a fresh page-unbound chat.",
      },
      pageId: {
        type: "string",
        description:
          "Optional. Bind a NEW chat to one page so the agent's page-context block is populated. Same shape as /edit?page=<id>.",
      },
    },
  },
};

/** The chat server's whole tool list — static, so it also serves the credential-less listing (#841). */
export const CHAT_TOOLS = [UPLOAD_IMAGES_TOOL, AWAIT_APPROVAL_TOOL, CHAT_TOOL] as const;

const caeloChatInputSchema = z
  .object({
    attachments: z.array(uploadedImageSchema).max(4).optional(),
    message: z.string().min(1).max(50_000),
    chatSessionId: z.string().uuid().optional(),
    pageId: z.string().uuid().optional(),
  })
  .strict();

export async function startMcpServer(opts: StartOpts): Promise<void> {
  const server = new Server(
    {
      name: "caelo-mcp-server",
      version: ownVersion(),
    },
    {
      capabilities: { tools: {} },
      instructions: CHAT_MCP_INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...CHAT_TOOLS] }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
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
        fetchState: () => fetchChatApprovalState({ ...opts, chatSessionId }),
        resume: () => resumeChat({ ...opts, chatSessionId }),
        waitMs,
        // The resume POST's whole timeout stays inside the call's budget.
        resumeReserveMs: resumeTimeoutMs(),
        ...(opts.approvalPollMs !== undefined ? { intervalMs: opts.approvalPollMs } : {}),
        ...(onPending ? { onPending } : {}),
      });

    if (req.params.name === UPLOAD_IMAGES_TOOL.name) {
      try {
        return await uploadImages(opts, req.params.arguments);
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: String(e) }] };
      }
    }
    if (req.params.name === AWAIT_APPROVAL_TOOL.name) {
      const parsed = awaitApprovalInput.safeParse(req.params.arguments ?? {});
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
          Math.max(resolveApprovalWaitMs(), resumeTimeoutMs() + RESUME_SLACK_MS),
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
    if (req.params.name !== "caelo_chat") {
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
      const result = await sendChat({
        adminUrl: opts.adminUrl,
        token: opts.token,
        message: parsed.data.message,
        ...(parsed.data.attachments ? { attachments: parsed.data.attachments } : {}),
        ...(parsed.data.chatSessionId ? { chatSessionId: parsed.data.chatSessionId } : {}),
        ...(parsed.data.pageId ? { pageId: parsed.data.pageId } : {}),
      });
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
          Math.max(0, resolveApprovalWaitMs() - (Date.now() - startedAt)),
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

  await server.connect(opts.transport ?? new StdioServerTransport());
}
