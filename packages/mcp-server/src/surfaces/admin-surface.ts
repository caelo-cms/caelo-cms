// SPDX-License-Identifier: MPL-2.0

/**
 * The Power-MCP server (issue #376), independent of how it reaches Caelo:
 * the chat-runner tool catalogue for an agent that drives the tool loop
 * itself, plus the companion tools `caelo_open_session`,
 * `caelo_get_context`, `caelo_await_approval` and `caelo_upload_images`.
 *
 * The stdio shim (../admin-server.ts) backs it with HTTP calls to
 * `/api/mcp/*`, caching the catalogue and holding the work session in
 * process memory. The admin's remote endpoint `/api/mcp/remote/admin`
 * (issue #806) backs it with the `mcp.*` ops in-process; its transport is
 * stateless, so the work session lives on the connection's row instead.
 * Both show an agent the same tools and the same results.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  type ApprovalOutcome,
  describeApprovalOutcome,
  waitForApproval,
} from "../approval-wait.js";
import {
  ADMIN_AWAIT_APPROVAL_TOOL,
  ADMIN_LOCAL_TOOLS,
  ADMIN_MCP_INSTRUCTIONS,
  adminAwaitApprovalInput,
  GET_CONTEXT_TOOL,
  OPEN_SESSION_TOOL,
  type OpenSessionInput,
  openSessionInput,
  UPLOAD_IMAGES_TOOL,
} from "../tool-definitions.js";

/** One catalogue entry, as `mcp.list_tools` returns it. */
export interface RemoteTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly gated?: boolean;
}

/** What `mcp.execute_tool` returns. */
export interface ExecuteToolResponse {
  readonly ok: boolean;
  readonly content: string;
  readonly requestId: string;
  readonly toolCallId: string;
  readonly cached: boolean;
  readonly image?: { base64: string; mediaType: string } | null;
  readonly nextAction?: unknown;
  /** Issue #658 — set when the call queued an approval-gated proposal. */
  readonly approval?: { proposalId: string; domain: string } | null;
}

/** What `mcp.open_session` returns. */
export interface OpenSessionResponse {
  readonly chatSessionId: string;
  readonly chatBranchId: string;
  readonly title: string;
  readonly resumed: boolean;
}

/** What `mcp.get_context` returns. */
export interface GetContextResponse {
  readonly systemContext: string;
  readonly statusLine: string | null;
  readonly skills: ReadonlyArray<{
    slug: string;
    displayName: string;
    description: string;
    allowlistedTools: string[];
  }>;
}

/** What the admin surface needs from Caelo — HTTP for the shim, ops in the admin. */
export interface AdminSurfaceBackend {
  /** The catalogue to list (the shim's cached copy, or the live one). */
  listCatalogue(): Promise<readonly RemoteTool[]>;
  /** One catalogue tool by name; the shim refreshes its cache on a miss (#678). */
  findTool(name: string): Promise<RemoteTool | undefined>;
  /** Open / resume the work session and remember it as current. */
  openSession(input: OpenSessionInput): Promise<OpenSessionResponse>;
  /** The current work session, or null before caelo_open_session. */
  currentSessionId(): Promise<string | null>;
  executeTool(call: {
    toolName: string;
    args: Record<string, unknown>;
    chatSessionId: string;
  }): Promise<ExecuteToolResponse>;
  getContext(): Promise<GetContextResponse>;
  /** Reads the operator's decision; the agent can never make it. */
  fetchApprovalOutcome(proposalId: string): Promise<ApprovalOutcome>;
  /**
   * #1122 — a call may have changed the catalogue (a plugin was activated,
   * disabled, uninstalled or reloaded). The stdio shim re-reads its cached
   * copy now and notifies over its own channel when it changed (false); a
   * stateless remote server lists live, so it asks the surface to send
   * `notifications/tools/list_changed` on this request's stream (true).
   */
  catalogueMayHaveChanged(): Promise<boolean>;
  uploadImages(args: unknown): Promise<CallToolResult>;
}

export interface AdminSurfaceOptions {
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
  /** Poll interval while waiting on an approval; tests shorten it. */
  readonly approvalPollMs?: number;
  /**
   * #678 / #1122 — advertise `tools.listChanged`: the shim notifies when its
   * cached catalogue changes, the stateless remote server on the response
   * stream of a call that changed it. Both surfaces set it.
   */
  readonly listChanged: boolean;
}

/** An outcome as an MCP tool result; a failed apply is an error result. */
function outcomeResult(o: ApprovalOutcome): CallToolResult & {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    ...(o.outcome === "failed" ? { isError: true as const } : {}),
    content: [
      { type: "text", text: describeApprovalOutcome(o) },
      {
        type: "text",
        text: JSON.stringify({
          proposalId: o.proposalId,
          outcome: o.outcome,
          detail: o.detail,
          decidedAt: o.decidedAt,
        }),
      },
    ],
  };
}

/**
 * #1122 — calls after which the catalogue may differ: an applied proposal of
 * the plugins domain (activate, uninstall, revoke a grant) and a reload.
 * Without a notification the client kept its old tool list until the
 * operator reconnected (`/mcp`), so an activated plugin's tools stayed out
 * of reach although `activate_plugin` promised them for the next turn.
 */
const RELOADING_TOOLS: ReadonlySet<string> = new Set(["reload_plugin"]);

function changesCatalogue(o: ApprovalOutcome): boolean {
  return o.outcome === "applied" && o.domain === "plugins";
}

function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/** Build the Power-MCP server over `backend`. The caller connects a transport. */
export function createAdminMcpServer(
  backend: AdminSurfaceBackend,
  opts: AdminSurfaceOptions,
): Server {
  const uploadTool = opts.uploadImagesTool ?? UPLOAD_IMAGES_TOOL;
  const server = new Server(
    { name: "caelo-admin-mcp", version: opts.serverVersion },
    {
      capabilities: { tools: opts.listChanged ? { listChanged: true } : {} },
      instructions: ADMIN_MCP_INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...ADMIN_LOCAL_TOOLS.map((t) => (t === UPLOAD_IMAGES_TOOL ? uploadTool : t)),
      ...(await backend.listCatalogue()).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as { type: "object"; [k: string]: unknown },
      })),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra): Promise<CallToolResult> => {
    const name = req.params.name;
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
    const announceCatalogueChange = async (): Promise<void> => {
      if (await backend.catalogueMayHaveChanged()) {
        await extra.sendNotification({ method: "notifications/tools/list_changed" });
      }
    };
    const awaitOutcome = (proposalId: string) =>
      waitForApproval({
        fetchOutcome: () => backend.fetchApprovalOutcome(proposalId),
        waitMs: opts.approvalWaitMs(),
        ...(opts.approvalPollMs !== undefined ? { intervalMs: opts.approvalPollMs } : {}),
        ...(onPending ? { onPending } : {}),
      });
    try {
      if (name === ADMIN_AWAIT_APPROVAL_TOOL.name) {
        const parsed = adminAwaitApprovalInput.safeParse(req.params.arguments ?? {});
        if (!parsed.success) {
          return errorResult(`invalid arguments: ${parsed.error.message}`);
        }
        const outcome = await awaitOutcome(parsed.data.proposalId);
        if (changesCatalogue(outcome)) await announceCatalogueChange();
        return outcomeResult(outcome);
      }
      if (name === uploadTool.name) return await backend.uploadImages(req.params.arguments);
      if (name === OPEN_SESSION_TOOL.name) {
        const parsed = openSessionInput.safeParse(req.params.arguments ?? {});
        if (!parsed.success) {
          return errorResult(`invalid arguments: ${parsed.error.message}`);
        }
        const session = await backend.openSession(parsed.data);
        return {
          content: [
            {
              type: "text",
              text:
                JSON.stringify(session, null, 2) +
                (session.resumed
                  ? `\nResumed the operator's session '${session.title}' — its earlier unstaged work continues here. `
                  : `\nOpened a new session '${session.title}'. `) +
                "Subsequent caelo tool calls write to the site's shared draft (or this session's experiment branch). " +
                "Stage finished work with stage_changes; the operator clicks Publish live in the Caelo admin.",
            },
          ],
        };
      }

      if (name === GET_CONTEXT_TOOL.name) {
        const context = await backend.getContext();
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

      const remote = await backend.findTool(name);
      if (!remote) {
        return errorResult(`unknown tool: ${name}`);
      }
      const chatSessionId = await backend.currentSessionId();
      if (!chatSessionId) {
        return errorResult(
          "no open work session — call caelo_open_session first. Every caelo write lands on a " +
            "session's preview branch; without one there is nothing to write to.",
        );
      }
      const result = await backend.executeTool({
        toolName: name,
        args: req.params.arguments ?? {},
        chatSessionId,
      });
      if (result.approval) {
        // Issue #658 — the call queued a proposal: wait for the operator's
        // decision (bounded) and return it in THIS result, so the agent
        // continues with the outcome instead of a "queued" note.
        const outcome = await awaitOutcome(result.approval.proposalId);
        if (changesCatalogue(outcome)) await announceCatalogueChange();
        const decided = outcomeResult(outcome);
        return {
          ...decided,
          content: [
            ...decided.content,
            {
              type: "text",
              text: JSON.stringify({ requestId: result.requestId, cached: result.cached }),
            },
          ],
        };
      }
      if (result.ok && RELOADING_TOOLS.has(name)) await announceCatalogueChange();
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

  return server;
}
