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
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { sendChat } from "./chat-bridge.js";
import { UPLOAD_IMAGES_TOOL, uploadedImageSchema, uploadImages } from "./image-upload.js";
import { MCP_SERVER_VERSION } from "./version.js";

export interface StartOpts {
  readonly adminUrl: string;
  readonly token: string;
}

const caeloChatInputSchema = z
  .object({
    attachments: z.array(uploadedImageSchema).max(4).optional(),
    message: z.string().min(1).max(50_000),
    chatSessionId: z.string().uuid().optional(),
    pageId: z.string().uuid().optional(),
  })
  .strict();

/**
 * MCP `instructions` for the initialize result — clients put these into
 * the model's context on connect. Short on purpose: the Caelo agent on
 * the other end of caelo_chat already holds the site context.
 */
export const CHAT_MCP_INSTRUCTIONS = [
  "Caelo CMS chat bridge: caelo_chat talks to the Caelo install's own AI agent, which knows the site and does the editing.",
  "Describe the outcome you want in plain language rather than step-by-step module operations, and pass the returned chatSessionId to continue the same conversation.",
  "Edits land on a preview branch; the operator reviews and publishes in the Caelo admin. To share images, call caelo_upload_images first and pass its attachments to caelo_chat.",
].join("\n");

export async function startMcpServer(opts: StartOpts): Promise<void> {
  const server = createMcpServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/** Builds the chat server without binding a transport (tests bind an in-memory pair). */
export function createMcpServer(opts: StartOpts): Server {
  const server = new Server(
    {
      name: "caelo-mcp-server",
      version: MCP_SERVER_VERSION,
    },
    {
      capabilities: { tools: {} },
      instructions: CHAT_MCP_INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      UPLOAD_IMAGES_TOOL,
      {
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
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name === UPLOAD_IMAGES_TOOL.name) {
      try {
        return await uploadImages(opts, req.params.arguments);
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: String(e) }] };
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
      const result = await sendChat({
        adminUrl: opts.adminUrl,
        token: opts.token,
        message: parsed.data.message,
        ...(parsed.data.attachments ? { attachments: parsed.data.attachments } : {}),
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

  return server;
}
