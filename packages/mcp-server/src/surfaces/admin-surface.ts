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
 * (issue #806) backs it with the Power-MCP steps in-process; its transport
 * is stateless, so the work session is bound to the MCP transport session
 * (`Mcp-Session-Id`) in the database instead. Both show an agent the same
 * tools and the same results.
 *
 * Issue #1253 — one work session per agent. Several agents may share one
 * connection (a client's sub-agents), and a connection has one current
 * session at most, so every catalogue tool takes an optional
 * `workSessionId`: the session that call runs in. It is added to the
 * schemas here and taken off the arguments before the call reaches Caelo.
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
  WORK_SESSION_ARG,
  WORK_SESSION_PROPERTY,
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
  /** Open a new work session (or resume a named one) and remember it as current. */
  openSession(input: OpenSessionInput): Promise<OpenSessionResponse>;
  /**
   * Run one catalogue tool. `chatSessionId` is the call's own
   * `workSessionId`; without it the backend uses its current session and
   * throws {@link NoWorkSessionError} when it has none. `rpcRequestId` is
   * the JSON-RPC id of the `tools/call`, from which the backend derives an
   * idempotency key unique to its transport (a retried request with the
   * same id gets the first result).
   */
  executeTool(call: {
    toolName: string;
    args: Record<string, unknown>;
    chatSessionId?: string;
    rpcRequestId: string | number;
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

/** Thrown by a backend asked to run a call with no work session to run it in. */
export class NoWorkSessionError extends Error {
  override readonly name = "NoWorkSessionError";
  constructor() {
    super(
      "no open work session — call caelo_open_session first. Every caelo write lands in a session's chat; " +
        "when several agents share this connection, each opens its own session and passes it as workSessionId on every call.",
    );
  }
}

/** A catalogue tool's schema with the optional per-call work session (see the header). */
function withWorkSessionArg(schema: Record<string, unknown>): {
  type: "object";
  [k: string]: unknown;
} {
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  if (WORK_SESSION_ARG in properties) {
    // A tool's own argument of this name would be swallowed; the catalogue
    // test keeps every tool clear of it.
    throw new Error(`catalogue tool schema already declares "${WORK_SESSION_ARG}"`);
  }
  return {
    ...schema,
    type: "object",
    properties: { ...properties, [WORK_SESSION_ARG]: WORK_SESSION_PROPERTY },
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Split the per-call work session off a call's arguments. */
function takeWorkSession(
  raw: Record<string, unknown>,
):
  | { ok: true; workSessionId?: string; args: Record<string, unknown> }
  | { ok: false; message: string } {
  const { [WORK_SESSION_ARG]: value, ...args } = raw;
  if (value === undefined) return { ok: true, args };
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    return {
      ok: false,
      message: `${WORK_SESSION_ARG} must be the chatSessionId caelo_open_session returned (a UUID)`,
    };
  }
  return { ok: true, workSessionId: value, args };
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
        inputSchema: withWorkSessionArg(t.inputSchema),
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
                  ? `\nContinuing session '${session.title}' — its earlier unstaged work continues here. `
                  : `\nOpened a new session '${session.title}' (a chat of your own in the Caelo admin). `) +
                "Subsequent caelo tool calls write to the site's shared draft (or this session's experiment branch). " +
                `If other agents share this connection, pass ${WORK_SESSION_ARG}: "${session.chatSessionId}" on every call. ` +
                "Stage with stage_changes when the operator asks for it (otherwise offer it when a change is done); the operator clicks Publish live in the Caelo admin.",
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
      const split = takeWorkSession(req.params.arguments ?? {});
      if (!split.ok) return errorResult(split.message);
      let result: ExecuteToolResponse;
      try {
        result = await backend.executeTool({
          toolName: name,
          args: split.args,
          ...(split.workSessionId ? { chatSessionId: split.workSessionId } : {}),
          rpcRequestId: extra.requestId,
        });
      } catch (e) {
        if (e instanceof NoWorkSessionError) return errorResult(e.message);
        throw e;
      }
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
