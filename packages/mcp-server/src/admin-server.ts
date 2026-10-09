// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #376 — the Power-MCP server (`caelo-admin-mcp` / `caelo-mcp-server
 * admin`). Where the chat server routes editing through a tool that talks to Caelo's own
 * AI, this server exposes the whole chat-runner tool catalogue so the
 * CALLING agent (Claude Code et al.) drives the tool loop itself — no
 * Caelo-side reasoning cost.
 *
 * The catalogue is fetched live from `/api/mcp/tools` at startup (an
 * admin-scoped token is required; 'chat' tokens get a 401 with the fix).
 * Local companion tools:
 *
 * - `caelo_upload_images` — uploads local or base64 image references to the media library.
 * - `caelo_open_session` — resumes the operator's most recent open work
 *   session (issue #620; `newSession: true` opens a fresh one) whose
 *   preview branch every subsequent tool call writes to. The session id
 *   is held here in process state so the agent doesn't thread it through
 *   every call; it also rides the response so a restarted server can
 *   resume a specific session via `chatSessionId`.
 * - `caelo_get_context` — the composed site context (module model, tool
 *   playbook, staging rules, site memory, skills index) the agent should
 *   load once before working. For a checked-in variant, see
 *   `caelo-mcp-server export`.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { postAdmin, resolveTimeoutMs } from "./http.js";
import { UPLOAD_IMAGES_TOOL, uploadImages } from "./image-upload.js";

export interface StartAdminOpts {
  readonly adminUrl: string;
  readonly token: string;
  /** Defaults to stdio; tests pass an in-memory transport. */
  readonly transport?: Transport;
}

/**
 * MCP `instructions` for the admin server (#552). Clients such as Claude
 * Code put this into the agent's context on connect, so a freshly
 * connected agent knows the session protocol without the operator
 * pasting anything: without a session every write fails, without the
 * context it works without the site's rules and brand voice.
 */
export const ADMIN_MCP_INSTRUCTIONS = [
  "This server edits a Caelo CMS site. Before any other caelo tool:",
  "1. Call caelo_open_session once. It resumes the operator's most recent open session (pass newSession: true only when the operator asks for a fresh one; chatSessionId resumes a specific one). Every write lands on that session's preview branch; nothing reaches the live site until the operator reviews and publishes in the Caelo admin.",
  "2. Call caelo_get_context once and follow it: it carries the site model, tool playbook, staging rules, site memory (brand voice, glossary) and the skills index.",
  "3. Load every skill the context marks ALWAYS APPLIES with load_skill before the work it covers (e.g. before writing any visitor-facing copy).",
  "Tool errors name the next step to take; follow them instead of retrying unchanged.",
].join("\n");

interface RemoteTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly gated?: boolean;
}

interface ExecuteToolResponse {
  readonly ok: boolean;
  readonly content: string;
  readonly requestId: string;
  readonly toolCallId: string;
  readonly cached: boolean;
  readonly image?: { base64: string; mediaType: string } | null;
  readonly nextAction?: unknown;
}

interface OpenSessionResponse {
  readonly chatSessionId: string;
  readonly chatBranchId: string;
  readonly title: string;
  readonly resumed: boolean;
}

interface GetContextResponse {
  readonly systemContext: string;
  readonly statusLine: string | null;
  readonly skills: ReadonlyArray<{
    slug: string;
    displayName: string;
    description: string;
    allowlistedTools: string[];
  }>;
}

const openSessionInput = z
  .object({
    title: z.string().min(1).max(200).optional(),
    pageId: z.string().uuid().optional(),
    chatSessionId: z.string().uuid().optional(),
    newSession: z.boolean().optional(),
  })
  .strict();

const OPEN_SESSION_TOOL = {
  name: "caelo_open_session",
  description:
    "Open the Caelo work session your subsequent tool calls run in. Every write lands on the session's " +
    "preview branch — invisible to the live site until the operator reviews and publishes in the Caelo admin. " +
    "Call this ONCE before any other caelo tool. By default it RESUMES the operator's own most recent open " +
    "session (so earlier unstaged work continues in the same chat); pass newSession: true only when the " +
    "operator wants a separate fresh session, or chatSessionId to resume a specific one. Optional pageId " +
    "resumes (or opens) that page's session.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Session title shown in the Caelo admin chat list." },
      pageId: { type: "string", description: "Optional page UUID to bind the session to." },
      chatSessionId: {
        type: "string",
        description: "Resume this specific session instead of the most recent one.",
      },
      newSession: {
        type: "boolean",
        description: "Open a fresh session instead of resuming the most recent open one.",
      },
    },
  },
} as const;

const GET_CONTEXT_TOOL = {
  name: "caelo_get_context",
  description:
    "Fetch the Caelo install's composed site context: how pages/modules/content instances fit together, " +
    "the tool playbook, staging rules, site memory (brand voice, glossary) and the active skills index. " +
    "Load this once before working; load individual skills on demand via the load_skill tool.",
  inputSchema: { type: "object", properties: {} },
} as const;

export async function startAdminMcpServer(opts: StartAdminOpts): Promise<void> {
  // Fetch the live catalogue up front — a bad URL or a chat-scoped token
  // should fail loudly at startup, not on the first tool call.
  const catalogue = await postAdmin<{ tools: RemoteTool[] }>({
    adminUrl: opts.adminUrl,
    token: opts.token,
    path: "/api/mcp/tools",
    body: {},
    timeoutMs: resolveTimeoutMs(60_000),
  });
  const remoteByName = new Map(catalogue.tools.map((t) => [t.name, t]));

  let currentSession: OpenSessionResponse | null = null;

  const server = new Server(
    { name: "caelo-admin-mcp", version: "0.1.0" },
    { capabilities: { tools: {} }, instructions: ADMIN_MCP_INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      UPLOAD_IMAGES_TOOL,
      OPEN_SESSION_TOOL,
      GET_CONTEXT_TOOL,
      ...catalogue.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    try {
      if (name === UPLOAD_IMAGES_TOOL.name) return await uploadImages(opts, req.params.arguments);
      if (name === OPEN_SESSION_TOOL.name) {
        const parsed = openSessionInput.safeParse(req.params.arguments ?? {});
        if (!parsed.success) {
          return errorResult(`invalid arguments: ${parsed.error.message}`);
        }
        currentSession = await postAdmin<OpenSessionResponse>({
          adminUrl: opts.adminUrl,
          token: opts.token,
          path: "/api/mcp/session",
          body: parsed.data,
          timeoutMs: resolveTimeoutMs(30_000),
        });
        return {
          content: [
            {
              type: "text",
              text:
                JSON.stringify(currentSession, null, 2) +
                (currentSession.resumed
                  ? `\nResumed the operator's session '${currentSession.title}' — its earlier unstaged work continues here. `
                  : `\nOpened a new session '${currentSession.title}'. `) +
                "Subsequent caelo tool calls run on its preview branch. " +
                "The operator reviews + publishes in the Caelo admin.",
            },
          ],
        };
      }

      if (name === GET_CONTEXT_TOOL.name) {
        const context = await postAdmin<GetContextResponse>({
          adminUrl: opts.adminUrl,
          token: opts.token,
          path: "/api/mcp/context",
          body: { includeSkillBodies: false },
          timeoutMs: resolveTimeoutMs(60_000),
        });
        return {
          content: [
            { type: "text", text: context.systemContext },
            {
              type: "text",
              text: JSON.stringify(
                { statusLine: context.statusLine, skills: context.skills },
                null,
                2,
              ),
            },
          ],
        };
      }

      const remote = remoteByName.get(name);
      if (!remote) {
        return errorResult(`unknown tool: ${name}`);
      }
      if (!currentSession) {
        return errorResult(
          "no open work session — call caelo_open_session first. Every caelo write lands on a " +
            "session's preview branch; without one there is nothing to write to.",
        );
      }
      const result = await postAdmin<ExecuteToolResponse>({
        adminUrl: opts.adminUrl,
        token: opts.token,
        path: "/api/mcp/tool",
        body: {
          toolName: name,
          args: req.params.arguments ?? {},
          chatSessionId: currentSession.chatSessionId,
        },
        timeoutMs: resolveTimeoutMs(120_000),
      });
      return {
        ...(result.ok ? {} : { isError: true }),
        content: [
          { type: "text", text: result.content },
          ...(result.image
            ? [
                {
                  type: "image" as const,
                  data: result.image.base64,
                  mimeType: result.image.mediaType,
                },
              ]
            : []),
          {
            type: "text",
            text: JSON.stringify({
              requestId: result.requestId,
              cached: result.cached,
              ...(result.nextAction !== undefined ? { nextAction: result.nextAction } : {}),
            }),
          },
        ],
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return errorResult(`${name} failed: ${msg}`);
    }
  });

  await server.connect(opts.transport ?? new StdioServerTransport());
}

function errorResult(text: string): {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
} {
  return { isError: true, content: [{ type: "text", text }] };
}
