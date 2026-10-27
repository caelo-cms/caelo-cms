// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #376 — the Power-MCP stdio server (`caelo-admin-mcp` /
 * `caelo-mcp-server admin`). Where the chat server routes editing through a
 * tool that talks to Caelo's own AI, this server exposes the whole
 * chat-runner tool catalogue so the CALLING agent (Claude Code et al.)
 * drives the tool loop itself — no Caelo-side reasoning cost. Issue #741:
 * the AI work inside tools stays with the agent too unless the token's
 * Owner allowed "may use Caelo's AI" — tools then hand back work items
 * (translations, …) instead of calling the install's provider;
 * `caelo_get_context` explains the contract.
 *
 * The server itself (tools, companion tools, approval waits) is
 * ./surfaces/admin-surface.ts, shared with the admin's remote endpoint
 * (issue #806). This module is the stdio backend:
 *
 * - the catalogue is fetched live from `/api/mcp/tools` at startup (an
 *   admin-scoped token is required; 'chat' tokens get a 401 with the fix)
 *   and re-read on use once it is older than its max age (#678) — a change
 *   reaches the client through `notifications/tools/list_changed`, an
 *   unknown tool name refreshes too. Never on a timer: every request wakes
 *   the admin's Cloud Run instance, and an idle session left open overnight
 *   kept it running around the clock;
 * - the work session `caelo_open_session` opened is held in process state
 *   so the agent doesn't thread it through every call; it also rides the
 *   response so a restarted server can resume a specific session via
 *   `chatSessionId`.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type ApprovalOutcome, resolveApprovalWaitMs } from "./approval-wait.js";
import { postAdmin, resolveTimeoutMs } from "./http.js";
import { uploadImages } from "./image-upload.js";
import {
  createAdminMcpServer,
  type ExecuteToolResponse,
  type GetContextResponse,
  type OpenSessionResponse,
  type RemoteTool,
} from "./surfaces/admin-surface.js";
import { ownVersion } from "./version-handshake.js";

export interface StartAdminOpts {
  readonly adminUrl: string;
  readonly token: string;
  /** Defaults to stdio; tests pass an in-memory transport. */
  readonly transport?: Transport;
  /** Poll interval while waiting on an approval; tests shorten it. */
  readonly approvalPollMs?: number;
  /**
   * #678 — how old the catalogue may get before the next use of this server
   * re-reads it, so a changed admin (an upgrade, an activated plugin)
   * reaches the client through `notifications/tools/list_changed`. Default
   * `CAELO_MCP_CATALOGUE_MAX_AGE_MS` or 5 minutes; 0 re-reads on every use.
   * An unknown tool name re-reads regardless.
   */
  readonly catalogueMaxAgeMs?: number;
}

const DEFAULT_CATALOGUE_MAX_AGE_MS = 5 * 60_000;

/** The catalogue's max age: the option, else the env var, else 5 minutes. */
export function resolveCatalogueMaxAgeMs(
  option: number | undefined,
  env: string | undefined = process.env.CAELO_MCP_CATALOGUE_MAX_AGE_MS,
): number {
  if (option !== undefined) return option;
  const n = env === undefined ? Number.NaN : Number(env);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_CATALOGUE_MAX_AGE_MS;
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

export async function startAdminMcpServer(opts: StartAdminOpts): Promise<void> {
  const target = { adminUrl: opts.adminUrl, token: opts.token };
  const fetchCatalogue = () =>
    postAdmin<{ tools: RemoteTool[] }>({
      ...target,
      path: "/api/mcp/tools",
      body: {},
      timeoutMs: resolveTimeoutMs(60_000),
    });
  // Fetch the live catalogue up front — a bad URL or a chat-scoped token
  // should fail loudly at startup, not on the first tool call.
  let catalogue = await fetchCatalogue();
  let fetchedAt = Date.now();
  let remoteByName = new Map(catalogue.tools.map((t) => [t.name, t]));
  let signature = catalogueSignature(catalogue.tools);
  const maxAgeMs = resolveCatalogueMaxAgeMs(opts.catalogueMaxAgeMs);

  let currentSession: OpenSessionResponse | null = null;
  let connected = false;
  let refreshing: Promise<boolean> | null = null;

  // #678 — the catalogue is the ADMIN's: an upgrade or an activated plugin
  // changes it while this process runs. `listChanged` tells the client to
  // re-list when we say so, instead of the operator reconnecting (/mcp).
  const server = createAdminMcpServer(
    {
      listCatalogue: async () => {
        // The client is listing right now: answer with the current list.
        if (isStale()) await refreshCatalogue();
        return catalogue.tools;
      },
      findTool: async (name) => {
        if (!remoteByName.has(name)) {
          // The admin may have gained the tool since we last listed (#678).
          await refreshCatalogue();
        } else {
          refreshInBackgroundIfStale();
        }
        return remoteByName.get(name);
      },
      openSession: async (input) => {
        refreshInBackgroundIfStale();
        currentSession = await postAdmin<OpenSessionResponse>({
          ...target,
          path: "/api/mcp/session",
          body: input,
          timeoutMs: resolveTimeoutMs(30_000),
        });
        return currentSession;
      },
      currentSessionId: async () => currentSession?.chatSessionId ?? null,
      executeTool: (call) =>
        postAdmin<ExecuteToolResponse>({
          ...target,
          path: "/api/mcp/tool",
          body: call,
          timeoutMs: resolveTimeoutMs(120_000),
        }),
      getContext: () =>
        postAdmin<GetContextResponse>({
          ...target,
          path: "/api/mcp/context",
          body: { includeSkillBodies: false },
          timeoutMs: resolveTimeoutMs(60_000),
        }),
      fetchApprovalOutcome: (proposalId) =>
        postAdmin<ApprovalOutcome>({
          ...target,
          path: "/api/mcp/approval",
          body: { proposalId },
          timeoutMs: resolveTimeoutMs(30_000),
        }),
      uploadImages: (args) => uploadImages(target, args),
      // #1122 — re-read now; refreshCatalogue notifies over stdio itself
      // when the list changed, so the surface sends nothing more.
      catalogueMayHaveChanged: async () => {
        await refreshCatalogue();
        return false;
      },
    },
    {
      serverVersion: ownVersion(),
      approvalWaitMs: resolveApprovalWaitMs,
      listChanged: true,
      ...(opts.approvalPollMs !== undefined ? { approvalPollMs: opts.approvalPollMs } : {}),
    },
  );

  /** Re-read the catalogue; true (and a list_changed to the client) when it changed. */
  const refreshCatalogue = (): Promise<boolean> => {
    refreshing ??= (async () => {
      const next = await fetchCatalogue();
      fetchedAt = Date.now();
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
  const isStale = (): boolean => Date.now() - fetchedAt >= maxAgeMs;
  /** A call the agent makes anyway carries the re-read; it never waits on it. */
  const refreshInBackgroundIfStale = (): void => {
    if (!isStale()) return;
    refreshCatalogue().catch((e: unknown) => {
      // stderr: stdout is the stdio transport. A failed refresh keeps the
      // last catalogue; the next use (or an unknown tool) retries.
      console.error(
        `[caelo-admin-mcp] tool catalogue refresh failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
  };

  await server.connect(opts.transport ?? new StdioServerTransport());
  connected = true;
}
