// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #376 — the Power-MCP server (`caelo-admin-mcp` / `caelo-mcp-server
 * admin`). Where the chat server routes editing through a tool that talks to Caelo's own
 * AI, this server exposes the whole chat-runner tool catalogue so the
 * CALLING agent (Claude Code et al.) drives the tool loop itself — no
 * Caelo-side reasoning cost. Issue #741: the AI work inside tools stays with
 * the agent too unless the token's Owner allowed "may use Caelo's AI" —
 * tools then hand back work items (translations, …) instead of calling the
 * install's provider; `caelo_get_context` explains the contract.
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
 * - `caelo_await_approval` — issue #658: keep waiting for the operator's
 *   decision on a proposal an approval-gated tool queued (the gated call
 *   itself already waits, bounded by `CAELO_MCP_APPROVAL_WAIT_MS`).
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
import {
  type ApprovalOutcome,
  describeApprovalOutcome,
  resolveApprovalWaitMs,
  waitForApproval,
} from "./approval-wait.js";
import { postAdmin, resolveTimeoutMs } from "./http.js";
import { UPLOAD_IMAGES_TOOL, uploadImages } from "./image-upload.js";

export interface StartAdminOpts {
  readonly adminUrl: string;
  readonly token: string;
  /** Defaults to stdio; tests pass an in-memory transport. */
  readonly transport?: Transport;
  /** Poll interval while waiting on an approval; tests shorten it. */
  readonly approvalPollMs?: number;
  /**
   * #678 — how often the live catalogue is re-read so a changed admin
   * (an upgrade, an activated plugin) reaches the client through
   * `notifications/tools/list_changed`. Default
   * `CAELO_MCP_CATALOGUE_REFRESH_MS` or 5 minutes; 0 disables the timer
   * (an unknown tool name still triggers a refresh).
   */
  readonly catalogueRefreshMs?: number;
}

const DEFAULT_CATALOGUE_REFRESH_MS = 5 * 60_000;

/** The refresh interval: the option, else the env var, else 5 minutes. */
export function resolveCatalogueRefreshMs(
  option: number | undefined,
  env: string | undefined = process.env.CAELO_MCP_CATALOGUE_REFRESH_MS,
): number {
  if (option !== undefined) return option;
  const n = env === undefined ? Number.NaN : Number(env);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_CATALOGUE_REFRESH_MS;
}

/**
 * What a client sees of the catalogue; when it changes, the tool list
 * changed. Order-independent so a re-sorted catalogue is not a change.
 */
export function catalogueSignature(tools: readonly RemoteTool[]): string {
  return JSON.stringify(
    [...tools]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => [t.name, t.description, t.inputSchema, t.gated === true]),
  );
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
  "1. Call caelo_open_session once. It resumes the operator's most recent open session (pass newSession: true only when the operator asks for a fresh one; chatSessionId resumes a specific one). Every write lands in the site's shared draft (or the session's own experiment branch); you may stage finished work with stage_changes, but nothing reaches the live site until the operator clicks Publish live in the Caelo admin.",
  "2. Call caelo_get_context once and follow it: it carries the site model, tool playbook, staging rules, site memory (brand voice, glossary) and the skills index.",
  "3. Load every skill the context marks ALWAYS APPLIES with load_skill before the work it covers (e.g. before writing any visitor-facing copy).",
  "Every tool in this list works over MCP, including approval-gated ones (marked APPROVAL-GATED — deploys, users/roles, languages/locales, plugin settings, bulk deletes …). Call them yourself: Caelo shows the operator an approval card in the Caelo admin (their Live Edit chat and the pending-approvals page), the call waits for Approve/Reject and returns the decision; if the wait times out, call caelo_await_approval with the proposalId. Tell the operator what you requested and that they approve the card in Caelo. Never ask the operator to paste a prompt into the Caelo admin chat or to do a step there that a tool here can do, and never re-propose a pending proposal.",
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
  /** Issue #658 — set when the call queued an approval-gated proposal. */
  readonly approval?: { proposalId: string; domain: string } | null;
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
    "Open the Caelo work session your subsequent tool calls run in. Every write lands in the site's shared " +
    "draft — invisible to the live site until it is staged and the operator clicks Publish live in the Caelo admin. " +
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

const awaitApprovalInput = z.object({ proposalId: z.string().uuid() }).strict();

/** Issue #658 — keep waiting for a decision after a gated call's wait timed out. */
const AWAIT_APPROVAL_TOOL = {
  name: "caelo_await_approval",
  description:
    "Wait for the operator's Approve/Reject on a proposal you queued with an approval-gated tool, and return " +
    "the decision (applied / rejected with reason / …). Use it when a gated tool's result says it is still " +
    "waiting. You cannot approve anything yourself — only the operator can, in the Caelo admin.",
  inputSchema: {
    type: "object",
    properties: {
      proposalId: {
        type: "string",
        description: "The id from the gated tool's 'Queued proposal <id>' result.",
      },
    },
    required: ["proposalId"],
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
  const fetchCatalogue = () =>
    postAdmin<{ tools: RemoteTool[] }>({
      adminUrl: opts.adminUrl,
      token: opts.token,
      path: "/api/mcp/tools",
      body: {},
      timeoutMs: resolveTimeoutMs(60_000),
    });
  // Fetch the live catalogue up front — a bad URL or a chat-scoped token
  // should fail loudly at startup, not on the first tool call.
  let catalogue = await fetchCatalogue();
  let remoteByName = new Map(catalogue.tools.map((t) => [t.name, t]));
  let signature = catalogueSignature(catalogue.tools);

  let currentSession: OpenSessionResponse | null = null;

  // #678 — the catalogue is the ADMIN's: an upgrade or an activated plugin
  // changes it while this process runs. `listChanged` tells the client to
  // re-list when we say so, instead of the operator reconnecting (/mcp).
  const server = new Server(
    { name: "caelo-admin-mcp", version: "0.1.0" },
    { capabilities: { tools: { listChanged: true } }, instructions: ADMIN_MCP_INSTRUCTIONS },
  );

  let connected = false;
  let refreshing: Promise<boolean> | null = null;
  /** Re-read the catalogue; true (and a list_changed to the client) when it changed. */
  const refreshCatalogue = (): Promise<boolean> => {
    refreshing ??= (async () => {
      const next = await fetchCatalogue();
      const nextSignature = catalogueSignature(next.tools);
      if (nextSignature === signature) return false;
      catalogue = next;
      remoteByName = new Map(next.tools.map((t) => [t.name, t]));
      signature = nextSignature;
      if (connected) await server.sendToolListChanged();
      return true;
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  };
  const refreshMs = resolveCatalogueRefreshMs(opts.catalogueRefreshMs);
  const timer =
    refreshMs > 0
      ? setInterval(() => {
          refreshCatalogue().catch((e: unknown) => {
            // stderr: stdout is the stdio transport. A failed refresh keeps
            // the last catalogue; the next tick (or an unknown tool) retries.
            console.error(
              `[caelo-admin-mcp] tool catalogue refresh failed: ${e instanceof Error ? e.message : String(e)}`,
            );
          });
        }, refreshMs)
      : null;
  timer?.unref?.();
  server.onclose = () => {
    if (timer) clearInterval(timer);
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      UPLOAD_IMAGES_TOOL,
      OPEN_SESSION_TOOL,
      GET_CONTEXT_TOOL,
      AWAIT_APPROVAL_TOOL,
      ...catalogue.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    ],
  }));

  /** Reads the operator's decision; the agent can never make it. */
  const fetchOutcome = (proposalId: string) => () =>
    postAdmin<ApprovalOutcome>({
      adminUrl: opts.adminUrl,
      token: opts.token,
      path: "/api/mcp/approval",
      body: { proposalId },
      timeoutMs: resolveTimeoutMs(30_000),
    });

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
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
    try {
      if (name === AWAIT_APPROVAL_TOOL.name) {
        const parsed = awaitApprovalInput.safeParse(req.params.arguments ?? {});
        if (!parsed.success) {
          return errorResult(`invalid arguments: ${parsed.error.message}`);
        }
        const outcome = await waitForApproval({
          fetchOutcome: fetchOutcome(parsed.data.proposalId),
          waitMs: resolveApprovalWaitMs(),
          ...(opts.approvalPollMs !== undefined ? { intervalMs: opts.approvalPollMs } : {}),
          ...(onPending ? { onPending } : {}),
        });
        return outcomeResult(outcome);
      }
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
                "Subsequent caelo tool calls write to the site's shared draft (or this session's experiment branch). " +
                "Stage finished work with stage_changes; the operator clicks Publish live in the Caelo admin.",
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

      let remote = remoteByName.get(name);
      if (!remote) {
        // The admin may have gained the tool since we last listed (#678).
        await refreshCatalogue();
        remote = remoteByName.get(name);
      }
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
      if (result.approval) {
        // Issue #658 — the call queued a proposal: wait for the operator's
        // decision (bounded) and return it in THIS result, so the agent
        // continues with the outcome instead of a "queued" note.
        const outcome = await waitForApproval({
          fetchOutcome: fetchOutcome(result.approval.proposalId),
          waitMs: resolveApprovalWaitMs(),
          ...(opts.approvalPollMs !== undefined ? { intervalMs: opts.approvalPollMs } : {}),
          ...(onPending ? { onPending } : {}),
        });
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
  connected = true;
}

/** An outcome as an MCP tool result; a failed apply is an error result. */
function outcomeResult(o: ApprovalOutcome): {
  isError?: true;
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

function errorResult(text: string): {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
} {
  return { isError: true, content: [{ type: "text", text }] };
}
