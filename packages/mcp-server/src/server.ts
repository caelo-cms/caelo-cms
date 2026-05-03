// SPDX-License-Identifier: MPL-2.0

/**
 * MCP server construction. Registers exactly one tool — `caelo_chat` —
 * and binds it to a stdio transport. The single-tool design is
 * deliberate: the remote agent talks to Caelo's chat-runner the same
 * way a human in the browser does. Browse / publish / propose actions
 * happen through the chat ("which pages exist?" → agent calls
 * pages.list internally → text response). Same auth surface, same
 * actor scope, same audit trail.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { sendChat } from "./chat-bridge.js";

export interface StartOpts {
  readonly adminUrl: string;
  readonly token: string;
}

const caeloChatInputSchema = z
  .object({
    message: z.string().min(1).max(50_000),
    chatSessionId: z.string().uuid().optional(),
    pageId: z.string().uuid().optional(),
  })
  .strict();

export async function startMcpServer(opts: StartOpts): Promise<void> {
  const server = new Server(
    {
      name: "caelo-mcp-server",
      version: "0.1.0",
    },
    {
      capabilities: { tools: {} },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "caelo_chat",
        description:
          "Talk to your Caelo CMS install's AI agent. Same agent that powers the live-edit chat overlay — it can read pages, propose edits, queue Owner-approval proposals, summarise plugin data. Continues an existing chat session (when chatSessionId is supplied) or starts a fresh one. Returns the agent's reply text plus structured tool-call summaries.",
        inputSchema: {
          type: "object",
          required: ["message"],
          properties: {
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
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== "caelo_chat") {
      return {
        isError: true,
        content: [
          { type: "text", text: `unknown tool: ${req.params.name}` },
        ],
      };
    }
    const parsed = caeloChatInputSchema.safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      return {
        isError: true,
        content: [
          { type: "text", text: `invalid arguments: ${parsed.error.message}` },
        ],
      };
    }
    try {
      const result = await sendChat({
        adminUrl: opts.adminUrl,
        token: opts.token,
        message: parsed.data.message,
        ...(parsed.data.chatSessionId ? { chatSessionId: parsed.data.chatSessionId } : {}),
        ...(parsed.data.pageId ? { pageId: parsed.data.pageId } : {}),
      });
      // Two content blocks: human-readable assistant text + a JSON
      // structured block the calling agent can parse for the
      // requestId, tool calls, cost, pending proposals.
      return {
        content: [
          { type: "text", text: result.assistant },
          {
            type: "text",
            text: JSON.stringify(
              {
                chatSessionId: result.chatSessionId,
                requestId: result.requestId,
                toolCalls: result.toolCalls,
                pendingProposals: result.pendingProposals,
                costMicrocents: result.costMicrocents,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        isError: true,
        content: [{ type: "text", text: `caelo_chat failed: ${msg}` }],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
