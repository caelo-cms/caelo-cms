// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #376 — Power-MCP ops: the admin-scoped MCP surface that exposes
 * the chat-runner tool catalogue to an EXTERNAL agent (Claude Code or any
 * MCP client). The external agent drives the tool loop itself; Caelo
 * executes one tool per `mcp.execute_tool` call with the same
 * ExecutionContext the chat-runner would use — so snapshots, audit,
 * branch scoping and chat-task grouping are byte-identical to a browser
 * chat. The reasoning runs in the caller's own agent, on its own
 * subscription — that is the point of this surface.
 *
 * Issue #741 — and the AI work of a tool call stays there too. Unless the
 * token's Owner allowed it (`allow_caelo_ai`), a call is AI-delegated: the
 * tool sees a provider that refuses to generate and plugins see
 * `invocation.aiDelegated`, so nothing spends the install's AI. Tools whose
 * AI part the agent can do (translation, moduleize, page extraction, …)
 * hand back a work item or an actionable error instead; image generation
 * points the agent at caelo_upload_images. With the opt-in on, the token's cost
 * cap applies to every call.
 *
 * Invariants preserved (CLAUDE.md §11.A):
 * - Calls dispatch as an AI actor bound to the token's owner. An external
 *   model is an AI actor no matter who runs it, so human-only ops stay
 *   unreachable and every approval-gated tool queues instead of applying
 *   ("Queued proposal <uuid>: …"): gated `propose_*` tools fall back to
 *   their propose-only handler, `needsApproval` tools queue through the
 *   dispatcher, and approval-declared plugin tools queue through
 *   `queuePluginToolApproval` (#687). The operator approves (in the Live
 *   Edit chat's card or the pending queue), never the caller. Issue #658:
 *   the proposal is recorded as requested by the external agent, and the
 *   decision is handed back to it through mcp.get_approval_outcome — it
 *   never starts a Live Edit AI turn.
 * - Every call runs inside a chat session's binding (the site's shared
 *   draft, or an isolated experiment/migration branch). The AI may Stage
 *   (stage_changes, issue #620); Publish live stays the operator's click
 *   in the admin UI, and an AI Stage never publishes automatically.
 */

import { pluginToolsRegistry, runPluginOperation } from "@caelo-cms/plugin-host";
import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { defineOperation, execute } from "@caelo-cms/query-api";
import { type ExecutionContext, err, ok, untrustedToolResult } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { buildSkillsContext } from "../../ai/chat-runner/context/skills.js";
import { buildStatusLine } from "../../ai/chat-runner/context-blocks.js";
import { loadMemory } from "../../ai/chat-runner/persistence.js";
import { withTakeoverNotices } from "../../ai/chat-runner/tool-dispatch.js";
import { isReadOrMetaTool } from "../../ai/chat-runner/write-tools.js";
import { delegatedProvider } from "../../ai/delegated-provider.js";
import { chatPluginInvocation } from "../../ai/plugin-invocation.js";
import { queuePluginToolApproval } from "../../ai/queued-tool-approval.js";
import { composeSystemPromptChunks } from "../../ai/system-prompt.js";
import { keptCallArgs, RETRY_TOOL_NAME, withKeptCallNotice } from "../../ai/tools/_retry-keep.js";
import type { ToolRegistry, ToolResult } from "../../ai/tools/dispatch.js";
import { createDefaultToolRegistry } from "../../ai/tools/index.js";
import { installUnavailableToolNames } from "../../ai/tools/install-availability.js";
import { mcpAgentOpFields } from "../chat/mcp-agent.js";
import {
  approvalOutcome,
  findMcpHandoffByToolCall,
  readHandoffForAgent,
  recordMcpHandoff,
} from "../mcp_approval_handoffs.js";
import { exactlyOneMcpCredential, mcpCredentialShape } from "./mcp_credential.js";
import { withUnavailableToolsNote } from "./mcp_power_prose.js";
import { type McpPrincipal, mcpAgentRefOf } from "./mcp_principal.js";
import { getMcpBridge, resolveMcpPrincipal, type SendChatBridgeOpts } from "./mcp_tokens.js";

/**
 * Tools that only work inside the chat-runner loop or the browser SSE
 * stream — they are filtered from the Power-MCP catalogue and refused at
 * execute time, each with the reason the external agent needs to route
 * around it.
 */
export const POWER_MCP_EXCLUDED_TOOLS: ReadonlyMap<string, string> = new Map([
  [
    "spawn_subagent",
    "subagents need the chat-runner loop; your own agent runtime provides parallelism instead",
  ],
  [
    "spawn_subagents",
    "subagents need the chat-runner loop; your own agent runtime provides parallelism instead",
  ],
  ["offer_choices", "renders chat-UI choice chips; ask your own operator directly"],
  ["submit_result", "subagent-only structured result channel"],
]);

/**
 * Tools whose RESULT is instruction prose the agent follows, not site data.
 * Only these results get the excluded-tool note (see
 * `surfaceToolResultContent`). Today that is `load_skill`: its result IS the
 * skill body, the same text `mcp.get_context` notes for the skills index
 * and the CLAUDE.md export.
 */
export const POWER_MCP_INSTRUCTION_RESULT_TOOLS: ReadonlySet<string> = new Set(["load_skill"]);

/**
 * Bug 2c323d9a — the surface-honesty note (issue #413) is for prose the
 * agent reads as instructions. Every other tool result carries site data
 * (content values, module bodies, page HTML, grep hits …) that the agent
 * reads and writes back; noting it injected the note into a docs page's
 * `<code>spawn_subagent</code>` and the read-modify-write persisted it to the
 * live site. Data results therefore pass through byte-for-byte.
 */
export function surfaceToolResultContent(toolName: string, content: string): string {
  return POWER_MCP_INSTRUCTION_RESULT_TOOLS.has(toolName)
    ? withUnavailableToolsNote(content, POWER_MCP_EXCLUDED_TOOLS)
    : content;
}

const toolCatalogueEntry = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  /** Present (true) for tools that always need the operator's approval
   *  (gated propose_* tools, approval-declared plugin tools) — the call
   *  queues an approval card instead of applying (the description says so
   *  too). */
  gated: z.boolean().optional(),
});

/**
 * The provider-shaped catalogue minus the excluded set, plus any live
 * Tier-1 plugin tools. Exported for the unit test.
 *
 * issue #413 — descriptions get the unavailable-tools note at this boundary rather than
 * reworded at their author sites: several descriptions (correctly, for
 * the chat surface) route to `screenshot_page` and friends, and the
 * in-app copies must stay untouched. Annotating here keeps every current
 * AND future description honest on this surface with one transform.
 */
export function powerToolCatalogue(
  tools: ToolRegistry,
  opts: {
    readonly aiDelegated?: boolean;
    /** Tools this install cannot run (`installUnavailableToolNames`); left
     *  out of the list. The release snapshot omits it and lists every tool. */
    readonly unavailable?: ReadonlySet<string>;
  } = {},
): z.infer<typeof toolCatalogueEntry>[] {
  // #741 — on a token whose AI work stays with the agent, every tool that
  // would spend the install's AI says what it does here instead.
  const withAiNote = (name: string, description: string) =>
    opts.aiDelegated && toolUsesInstallAi(tools, name)
      ? `${description}${MCP_DELEGATED_AI_NOTE}`
      : description;
  const core = tools
    .catalogue()
    .filter((t) => !POWER_MCP_EXCLUDED_TOOLS.has(t.name) && !opts.unavailable?.has(t.name))
    .map((t) => {
      const conditional = !t.gated && tools.get(t.name)?.needsApproval !== undefined;
      const description = withAiNote(
        t.name,
        withUnavailableToolsNote(t.description, POWER_MCP_EXCLUDED_TOOLS),
      );
      return {
        name: t.name,
        description: t.gated
          ? `${description}${MCP_APPROVAL_NOTE}`
          : conditional
            ? `${description}${MCP_CONDITIONAL_APPROVAL_NOTE}`
            : description,
        inputSchema: t.inputSchema,
        ...(t.gated ? { gated: true } : {}),
      };
    });
  // Same exclusion filter as core tools (PR #420 review): a plugin tool
  // whose name collides with an excluded one would otherwise be advertised
  // here yet refused by mcp.execute_tool — the exact catalogue↔prose
  // inconsistency this module exists to prevent.
  const plugin = pluginToolsRegistry
    .list()
    .filter((p) => !POWER_MCP_EXCLUDED_TOOLS.has(p.spec.name))
    .map((p) => {
      const description = withAiNote(
        p.spec.name,
        withUnavailableToolsNote(p.spec.description, POWER_MCP_EXCLUDED_TOOLS),
      );
      return {
        name: p.spec.name,
        description: p.spec.approvalMode ? `${description}${MCP_APPROVAL_NOTE}` : description,
        inputSchema: p.spec.inputJsonSchema,
        ...(p.spec.approvalMode ? { gated: true } : {}),
      };
    });
  return [...core, ...plugin];
}

/**
 * #741 — whether `toolName` (core or plugin) declares that it can spend
 * the install's AI. Exported for the unit test.
 */
export function toolUsesInstallAi(tools: ToolRegistry, toolName: string): boolean {
  return (
    tools.get(toolName)?.usesInstallAi === true ||
    pluginToolsRegistry.resolve(toolName)?.spec.usesInstallAi === true
  );
}

/** #741 — appended to tools that would spend the install's AI, on a token where they cannot. */
const MCP_DELEGATED_AI_NOTE =
  "\n\nOver this connection the install's AI is not used: the AI part comes back to you — a work item to answer with your own model " +
  "and send back through the tool it names, or an `AiDelegated:` answer that says what to do instead (see caelo_get_context).";

/**
 * #687 — what an approval-gated tool means on THIS surface. Tool
 * descriptions are written for the Live Edit chat ("the turn pauses on an
 * in-chat card"); read literally over MCP they made an external agent send
 * the operator to paste prompts into the admin chat. Appended at this
 * boundary so every current and future gated tool says it the same way.
 */
const MCP_APPROVAL_NOTE =
  "\n\nOver MCP: call this tool yourself — it works here. The call queues an approval card in the operator's Caelo admin " +
  "(their Live Edit chat and the pending-approvals page), waits for their Approve/Reject and returns the outcome " +
  "(if the wait times out, continue with caelo_await_approval). Tell the operator you requested it and that they " +
  "approve the card in Caelo; never ask them to paste a prompt into the Caelo chat to run it.";

const MCP_CONDITIONAL_APPROVAL_NOTE =
  "\n\nOver MCP: when this call needs the operator's approval, it queues an approval card in their Caelo admin " +
  "(Live Edit chat and the pending-approvals page) and returns the outcome once they decide — tell them to approve " +
  "the card; never ask them to paste a prompt into the Caelo chat.";

/**
 * Credential → principal for the Power-MCP surface: an admin-scoped token
 * or the remote admin connection (#806). Failures keep the `auth_error:` /
 * `permission_denied:` prefixes the HTTP shells map to 401 / 403.
 */
async function resolveAdminPrincipal(
  adapter: DatabaseAdapter,
  credential: Parameters<typeof resolveMcpPrincipal>[1],
  operation: string,
): Promise<({ ok: true } & McpPrincipal) | { ok: false; message: string }> {
  const r = await resolveMcpPrincipal(adapter, credential, { surface: "admin", operation });
  return r.ok ? { ok: true, ...r.principal } : r;
}

/** The Power-MCP ops' input: the credential plus the op's own fields. */
const withCredential = <T extends z.ZodRawShape>(shape: T) =>
  z
    .object({ ...mcpCredentialShape, ...shape })
    .strict()
    .refine(exactlyOneMcpCredential.check, { message: exactlyOneMcpCredential.message });

function bridgeOrError():
  | { ok: true; bridge: SendChatBridgeOpts }
  | { ok: false; message: string } {
  const bridge = getMcpBridge();
  if (!bridge) {
    return {
      ok: false,
      message: "MCP bridge not configured — admin bootstrap forgot to call configureMcpBridge",
    };
  }
  return { ok: true, bridge };
}

// ─── mcp.list_tools ──────────────────────────────────────────────────

export const mcpListToolsOp = defineOperation({
  name: "mcp.list_tools",
  // Why system-only: the bearer is in the input (same reason as
  // mcp.send_chat) — the HTTP shell dispatches as system, the handler
  // resolves the real actor itself.
  actorScope: ["system"],
  database: "cms_admin",
  // Issue #1210 — resolving the credential runs its own ops.
  transaction: "none",
  input: withCredential({}),
  output: z.object({ tools: z.array(toolCatalogueEntry) }),
  handler: async (_ctx, input, _tx) => {
    const bridged = bridgeOrError();
    if (!bridged.ok) {
      return err({ kind: "HandlerError", operation: "mcp.list_tools", message: bridged.message });
    }
    const auth = await resolveAdminPrincipal(bridged.bridge.adapter, input, "mcp.list_tools");
    if (!auth.ok) {
      return err({ kind: "HandlerError", operation: "mcp.list_tools", message: auth.message });
    }
    return ok({
      tools: powerToolCatalogue(createDefaultToolRegistry(), {
        aiDelegated: !auth.allowCaeloAi,
        unavailable: installUnavailableToolNames(process.env),
      }),
    });
  },
});

// ─── mcp.open_session ────────────────────────────────────────────────

/** Title of a session the Power-MCP opens without one. */
const MCP_SESSION_TITLE = "MCP · admin session";

/**
 * #806 — the remote transport is stateless (any instance may serve the next
 * request), so a remote connection's current work session lives on its row
 * instead of in the shim's process memory. Token sessions stay with the
 * stdio shim, which holds them itself.
 */
async function rememberRemoteSession(
  tx: Parameters<typeof recordMcpHandoff>[0],
  principal: McpPrincipal,
  chatSessionId: string,
): Promise<void> {
  if (principal.via.kind !== "remote") return;
  await tx.execute(sql`
    UPDATE mcp_remote_connections SET current_chat_session_id = ${chatSessionId}::uuid
    WHERE id = ${principal.via.connectionId}::uuid
  `);
}

export const mcpOpenSessionOp = defineOperation({
  name: "mcp.open_session",
  // Why system-only: the bearer token is in the input (same reason as mcp.list_tools) — the HTTP
  // shell dispatches as system and the handler resolves the real actor.
  actorScope: ["system"],
  database: "cms_admin",
  // Issue #1210 — an orchestration of chat ops: holding a transaction around
  // them would make every one a second checkout of the pool.
  transaction: "none",
  input: z
    .object({
      ...mcpCredentialShape,
      /** Resume this session (it must belong to the token's owner). */
      chatSessionId: z.string().uuid().optional(),
      /**
       * Issue #620 — open a FRESH session even though the owner has an
       * open one. Without it (and without chatSessionId) the owner's most
       * recently active open session is resumed.
       */
      newSession: z.boolean().optional(),
      title: z.string().min(1).max(200).optional(),
      /** Resume / bind to this page's session (subject to the one-open-chat-per-page gate). */
      pageId: z.string().uuid().optional(),
    })
    .strict()
    .refine(exactlyOneMcpCredential.check, { message: exactlyOneMcpCredential.message })
    .refine((v) => !(v.newSession && v.chatSessionId), {
      message:
        "pass chatSessionId to resume a session OR newSession: true for a fresh one, not both",
    }),
  output: z.object({
    chatSessionId: z.string(),
    chatBranchId: z.string(),
    title: z.string(),
    resumed: z.boolean(),
  }),
  handler: async (_ctx, input, tx) => {
    const bridged = bridgeOrError();
    if (!bridged.ok) {
      return err({ kind: "HandlerError", operation: "mcp.open_session", message: bridged.message });
    }
    const { adapter, registry } = bridged.bridge;
    const auth = await resolveAdminPrincipal(adapter, input, "mcp.open_session");
    if (!auth.ok) {
      return err({ kind: "HandlerError", operation: "mcp.open_session", message: auth.message });
    }
    const humanCtx: ExecutionContext = {
      actorId: auth.actorId,
      actorKind: "human",
      requestId: crypto.randomUUID(),
    };
    if (input.chatSessionId) {
      // chat.resolve_session filters by created_by: another user's session
      // reads as not found, so a token can never resume someone else's.
      const existing = await execute(registry, adapter, humanCtx, "chat.resolve_session", {
        chatSessionId: input.chatSessionId,
      });
      if (!existing.ok) {
        return err({
          kind: "HandlerError",
          operation: "mcp.open_session",
          message: `session_not_found: ${input.chatSessionId} — omit chatSessionId to resume your most recent open session, or pass newSession: true for a fresh one`,
        });
      }
      const v = existing.value as {
        session: {
          chatBranchId: string;
          title: string;
          publishedAt: string | null;
          archivedAt: string | null;
        };
      };
      if (v.session.publishedAt !== null || v.session.archivedAt !== null) {
        return err({
          kind: "HandlerError",
          operation: "mcp.open_session",
          message: `session_closed: ${input.chatSessionId} was already published, archived or discarded — omit chatSessionId to resume your most recent open session, or pass newSession: true`,
        });
      }
      await tx.transaction((t) => rememberRemoteSession(t, auth, input.chatSessionId as string));
      return ok({
        chatSessionId: input.chatSessionId,
        chatBranchId: v.session.chatBranchId,
        title: v.session.title,
        resumed: true,
      });
    }
    if (!input.newSession) {
      // Issue #620 — resume the owner's own most recent open session
      // instead of minting a new chat per MCP connection. chat.list_sessions
      // returns only the caller's sessions (created_by), excludes archived
      // (and therefore discarded) ones and subagent sessions, newest first.
      const listed = await execute(registry, adapter, humanCtx, "chat.list_sessions", {
        includeArchived: false,
        ...(input.pageId ? { pageId: input.pageId } : {}),
      });
      if (!listed.ok) {
        const detail = "message" in listed.error ? listed.error.message : listed.error.kind;
        return err({
          kind: "HandlerError",
          operation: "mcp.open_session",
          message: `session_lookup_failed: ${detail}`,
        });
      }
      const open = (
        listed.value as {
          sessions: {
            id: string;
            title: string;
            chatBranchId: string;
            publishedAt: string | null;
          }[];
        }
      ).sessions.find((s) => s.publishedAt === null);
      if (open) {
        await tx.transaction((t) => rememberRemoteSession(t, auth, open.id));
        return ok({
          chatSessionId: open.id,
          chatBranchId: open.chatBranchId,
          title: open.title,
          resumed: true,
        });
      }
    }
    const created = await execute(registry, adapter, humanCtx, "chat.create_session", {
      title: input.title ?? MCP_SESSION_TITLE,
      ...(input.pageId ? { pageId: input.pageId } : {}),
    });
    if (!created.ok) {
      const detail = "message" in created.error ? created.error.message : created.error.kind;
      return err({
        kind: "HandlerError",
        operation: "mcp.open_session",
        message: `session_create_failed: ${detail}`,
      });
    }
    const c = created.value as { chatSessionId: string; chatBranchId: string };
    await tx.transaction((t) => rememberRemoteSession(t, auth, c.chatSessionId));
    return ok({
      chatSessionId: c.chatSessionId,
      chatBranchId: c.chatBranchId,
      title: input.title ?? MCP_SESSION_TITLE,
      resumed: false,
    });
  },
});

// ─── mcp.execute_tool ────────────────────────────────────────────────

/**
 * #1275 — the tool a `retry_tool_call` would run: the kept call's tool
 * name, or `retry_tool_call` itself when the id names nothing (the retry
 * then refuses on its own).
 */
async function keptToolNameOf(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  ctx: ExecutionContext,
  chatSessionId: string,
  args: Record<string, unknown> | undefined,
): Promise<string> {
  const toolCallId = typeof args?.toolCallId === "string" ? args.toolCallId : null;
  if (!toolCallId) return RETRY_TOOL_NAME;
  const r = await execute(registry, adapter, ctx, "chat.lookup_tool_result", {
    chatSessionId,
    toolCallId,
  });
  const cached = r.ok ? (r.value as { cached: { toolName: string } | null }).cached : null;
  return cached?.toolName ?? RETRY_TOOL_NAME;
}

export const mcpExecuteToolOp = defineOperation({
  name: "mcp.execute_tool",
  // Why system-only: the bearer token is in the input — the handler resolves the token's actor and
  // dispatches the tool AS the AI actor bound to it.
  actorScope: ["system"],
  database: "cms_admin",
  // Issue #1210 — the tool runs for as long as it takes (image generation,
  // a server-side screenshot that loops back into the admin) and through
  // its own ops; no transaction may stay open around it.
  transaction: "none",
  input: z
    .object({
      ...mcpCredentialShape,
      /** The work session whose preview branch this call writes to. */
      chatSessionId: z.string().uuid(),
      toolName: z.string().min(1).max(120),
      args: z.record(z.string(), z.unknown()).optional(),
      /**
       * Caller-supplied idempotency key. Re-sending the same
       * (chatSessionId, toolCallId) returns the cached first result
       * instead of re-executing — same dedup the chat-runner uses.
       */
      toolCallId: z.string().min(1).max(128).optional(),
    })
    .strict()
    .refine(exactlyOneMcpCredential.check, { message: exactlyOneMcpCredential.message }),
  output: z.object({
    ok: z.boolean(),
    content: z.string(),
    requestId: z.string(),
    toolCallId: z.string(),
    /** True when the result came from the idempotency cache. */
    cached: z.boolean(),
    image: z.object({ base64: z.string(), mediaType: z.string() }).nullable().optional(),
    /** Structured recovery hint from the tool, passed through verbatim. */
    nextAction: z.unknown().optional(),
    /**
     * Issue #658 — set when the call queued an approval-gated proposal.
     * The operator decides in the Caelo admin; the decision is handed back
     * through mcp.get_approval_outcome (the MCP server waits on it).
     */
    approval: z.object({ proposalId: z.string(), domain: z.string() }).nullable().optional(),
  }),
  handler: async (_ctx, input, tx) => {
    const bridged = bridgeOrError();
    if (!bridged.ok) {
      return err({ kind: "HandlerError", operation: "mcp.execute_tool", message: bridged.message });
    }
    const { adapter, registry, resolveProvider } = bridged.bridge;
    const auth = await resolveAdminPrincipal(adapter, input, "mcp.execute_tool");
    if (!auth.ok) {
      return err({ kind: "HandlerError", operation: "mcp.execute_tool", message: auth.message });
    }

    const excludedReason = POWER_MCP_EXCLUDED_TOOLS.get(input.toolName);
    if (excludedReason) {
      return err({
        kind: "HandlerError",
        operation: "mcp.execute_tool",
        message: `tool '${input.toolName}' is not available over MCP: ${excludedReason}`,
      });
    }

    const requestId = crypto.randomUUID();
    const humanCtx: ExecutionContext = {
      actorId: auth.actorId,
      actorKind: "human",
      requestId,
    };
    // #1216 — the session row only: an MCP tool call needs the branch, not
    // the transcript.
    const session = await execute(registry, adapter, humanCtx, "chat.resolve_session", {
      chatSessionId: input.chatSessionId,
    });
    if (!session.ok) {
      return err({
        kind: "HandlerError",
        operation: "mcp.execute_tool",
        message:
          "session_not_found — open a work session first (mcp.open_session / the caelo_open_session tool) and pass its chatSessionId; every Power-MCP write lands on that session's preview branch.",
      });
    }
    const chatBranchId = (session.value as { session: { chatBranchId: string } }).session
      .chatBranchId;

    const toolCallId = input.toolCallId ?? `mcp-${crypto.randomUUID()}`;
    const humanCtxWithBranch: ExecutionContext = { ...humanCtx, chatBranchId };

    // Idempotency: only a CALLER-supplied key can legitimately repeat.
    if (input.toolCallId) {
      const cachedLookup = await execute(
        registry,
        adapter,
        humanCtxWithBranch,
        "chat.lookup_tool_result",
        { chatSessionId: input.chatSessionId, toolCallId },
      );
      const cached =
        cachedLookup.ok &&
        (cachedLookup.value as { cached: { ok: boolean; content: string } | null }).cached;
      if (cached) {
        // The first call recorded the hand-off (the cache keeps only
        // ok+content); serve the same handle.
        const approval = await tx.transaction((t) =>
          findMcpHandoffByToolCall(t, input.chatSessionId, toolCallId),
        );
        return ok({
          ok: cached.ok,
          content: cached.content,
          requestId,
          toolCallId,
          cached: true,
          approval,
        });
      }
    }

    // #741 — without the Owner's opt-in the call is AI-delegated and cannot
    // spend the install's AI at all, so there is nothing to cap.
    const aiDelegated = !auth.allowCaeloAi;

    // Per-token cost cap, enforced at this boundary because the
    // chat-runner's streaming cap does not run on the Power-MCP path.
    // Scope: the work session's accumulated ai_calls spend (core tools,
    // plugin ctx.ai calls and image generation all record against it) —
    // the closest analogue to the chat-runner's per-turn accumulation.
    // Which tools it gates comes from each tool's own `usesInstallAi`
    // declaration, not a list of names kept here: that list went stale
    // (#741) and let translation spend uncapped.
    // #1275 — a retry runs the KEPT call's tool, so the cap follows that
    // tool, not retry_tool_call (no new path around the cap).
    const capToolName =
      input.toolName === RETRY_TOOL_NAME
        ? await keptToolNameOf(
            registry,
            adapter,
            humanCtxWithBranch,
            input.chatSessionId,
            input.args,
          )
        : input.toolName;
    if (
      !aiDelegated &&
      auth.aiCostCapMicrocents !== null &&
      toolUsesInstallAi(createDefaultToolRegistry(), capToolName)
    ) {
      const credentialCreatedAt =
        auth.via.kind === "token"
          ? sql`(SELECT created_at FROM mcp_tokens WHERE id = ${auth.via.tokenId}::uuid)`
          : sql`(SELECT created_at FROM mcp_remote_connections WHERE id = ${auth.via.connectionId}::uuid)`;
      const spendRows = (await tx.transaction((t) =>
        t.execute(sql`
        SELECT COALESCE(SUM(cost_estimate_microcents), 0)::bigint AS spent
        FROM ai_calls
        WHERE chat_session_id = ${input.chatSessionId}::uuid
           OR (
             actor_id = ${auth.actorId}::uuid
             AND created_at >= ${credentialCreatedAt}
           )
      `),
      )) as unknown as Array<{ spent: bigint | string | number }>;
      const raw = spendRows[0]?.spent ?? 0;
      // Compare as bigint — a Number round-trip could lose precision past
      // 2^53 µ¢ and let a capped token slip through (review finding, PR #379).
      const spent =
        typeof raw === "bigint" ? raw : BigInt(typeof raw === "string" ? raw : Math.trunc(raw));
      if (spent >= BigInt(auth.aiCostCapMicrocents)) {
        return err({
          kind: "HandlerError",
          operation: "mcp.execute_tool",
          message:
            `cost cap reached: spent ~${spent} µ¢ / cap ${auth.aiCostCapMicrocents} µ¢ of the install's AI on this session — ` +
            `'${input.toolName}' uses the install's AI and was not run. Tools without AI work still run. Ask the Owner for a higher-cap token at /settings/mcp, ` +
            `or for a token without "may use Caelo's AI", which hands the AI work back to you instead of spending the install's AI.`,
        });
      }
    }

    // Dispatch as the AI actor on the session's branch. chatTaskId =
    // chatSessionId is the chat-runner's own convention — it is what
    // groups this call's snapshots under the session for chat-keyed undo.
    const aiCtx: ExecutionContext = {
      actorId: auth.actorId,
      actorKind: "ai",
      requestId,
      chatBranchId,
      chatTaskId: input.chatSessionId,
    };
    // Issues #664 / #665 — one agent works in a chat at a time, and the
    // operator can stop this one. Every call marks the external agent as
    // working in the session (the Live Edit chat then does not start a turn
    // of its own AI, and lists this agent with a Stop button); a call after
    // the operator stopped it is refused until they allow it again.
    const touchPresence = () =>
      execute(registry, adapter, humanCtxWithBranch, "chat.touch_external_agent", {
        chatSessionId: input.chatSessionId,
        ...mcpAgentOpFields(mcpAgentRefOf(auth)),
        label:
          `External agent "${auth.displayName}" (${auth.via.kind === "remote" ? "remote MCP" : "MCP"})`.slice(
            0,
            200,
          ),
      });
    const presence = await touchPresence();
    if (!presence.ok) {
      const detail = "message" in presence.error ? presence.error.message : presence.error.kind;
      return err({
        kind: "HandlerError",
        operation: "mcp.execute_tool",
        message: `presence_failed: ${detail} — nothing was executed; retry the call`,
      });
    }
    if ((presence.value as { stopped: boolean }).stopped) {
      return ok({
        ok: false,
        content: EXTERNAL_AGENT_STOPPED_TEXT,
        requestId,
        toolCallId,
        cached: false,
        image: null,
      });
    }
    // A write holds the chat's turn lease (0247) for the duration of the
    // call: it never runs while a Live Edit turn writes, and a Live Edit
    // turn waits the seconds this call takes. Reads need no exclusivity.
    const leaseHolderId = isReadOrMetaTool(input.toolName) ? null : `power-mcp:${requestId}`;
    if (leaseHolderId) {
      const lease = await execute(
        registry,
        adapter,
        humanCtxWithBranch,
        "chat.acquire_turn_lease",
        {
          chatSessionId: input.chatSessionId,
          holderId: leaseHolderId,
          ttlMs: POWER_MCP_CALL_LEASE_TTL_MS,
        },
      );
      if (!lease.ok) {
        const detail = "message" in lease.error ? lease.error.message : lease.error.kind;
        return err({
          kind: "HandlerError",
          operation: "mcp.execute_tool",
          message: `lease_failed: ${detail} — nothing was executed; retry the call`,
        });
      }
      const claim = lease.value as { acquired: boolean; heldBy: { acquiredAt: string } | null };
      if (!claim.acquired) {
        return ok({
          ok: false,
          content: chatBusyText(input.toolName, claim.heldBy?.acquiredAt ?? null),
          requestId,
          toolCallId,
          cached: false,
          image: null,
        });
      }
    }
    const dispatchAndRecord = async () => {
      const resolvedProvider = await resolveProvider();
      const provider =
        resolvedProvider && aiDelegated ? delegatedProvider(resolvedProvider) : resolvedProvider;
      const tools = createDefaultToolRegistry();

      // Tier-1 plugin tools route through the plugin host, exactly like the
      // chat-runner's dispatcher does (tool-dispatch.ts).
      //
      // #687 — an approval-declared plugin tool (set_locales, …) cannot
      // pause an SDK turn here (the external agent drives its own loop), so
      // it is queued for the operator instead: the card shows in their Live
      // Edit chat and the pending queue, Approve runs it through the plugin
      // host, and the decision is handed back below like any other gated
      // call. Running it unqueued would reopen the bypass #388 closed.
      const pluginTool = pluginToolsRegistry.resolve(input.toolName);
      const rawResult: ToolResult = pluginTool?.spec.approvalMode
        ? await queuePluginToolApproval({
            registry,
            adapter,
            aiCtx,
            operatorActorId: auth.actorId,
            chatSessionId: input.chatSessionId,
            pluginTool,
            args: input.args ?? {},
            aiDelegated,
          })
        : pluginTool
          ? await runPluginOperation({
              pluginSlug: pluginTool.pluginSlug,
              operationName: pluginTool.spec.operationName,
              args: input.args ?? {},
              invocation: chatPluginInvocation(aiCtx, auth.actorId, { aiDelegated }),
            }).then(
              (r): ToolResult =>
                r.ok
                  ? // #635 — plugin data may be visitor-written: data, never instructions.
                    { ok: true, content: untrustedToolResult(r.value) }
                  : { ok: false, content: `${r.error.kind}: ${r.error.message}` },
            )
          : await tools.dispatch(input.toolName, input.args ?? {}, aiCtx, {
              adapter,
              registry,
              chatSessionId: input.chatSessionId,
              chatBranchId,
              toolCallId,
              tools,
              humanCtx: humanCtxWithBranch,
              ...(provider ? { provider } : {}),
              ...(aiDelegated ? { aiDelegated: true } : {}),
              // No spawnChildChatTurn / requestScreenshot / pushClientEvent:
              // the tools that need them are in POWER_MCP_EXCLUDED_TOOLS.
              // screenshot_page works WITHOUT them since issue #412 — with no
              // pushClientEvent it renders the branch preview server-side and
              // returns the image, which flows to the MCP client as an image
              // content block.
            });

      // issue #413 — results that ARE instruction prose (load_skill's skill
      // bodies) get the same excluded-tool note as the catalogue,
      // BEFORE caching so replays serve the same honest copy. Every other
      // result is site data and must round-trip unchanged (bug 2c323d9a).
      // issue #620 — a write that took over another chat's lock (or lost one)
      // says so in this result, same as in the browser chat.
      // #1275 — a fixable failed write call is kept for retry_tool_call,
      // exactly like in the browser chat (plugin results never carry `call`).
      const keptArgs = keptCallArgs(rawResult, tools);
      const keptResult = keptArgs ? withKeptCallNotice(toolCallId, rawResult) : rawResult;
      const result: ToolResult = await withTakeoverNotices(
        registry,
        adapter,
        humanCtxWithBranch,
        input.chatSessionId,
        {
          ...keptResult,
          content: surfaceToolResultContent(input.toolName, keptResult.content),
        },
      );

      // Issue #620 — MCP work is activity in this session: without the bump
      // a later reconnect could resume a browser chat that merely looked
      // more recently active.
      if (result.ok) {
        await tx.transaction((t) =>
          t.execute(sql`
            UPDATE chat_sessions SET last_active_at = now() WHERE id = ${input.chatSessionId}::uuid
          `),
        );
      }

      // A kept call is recorded under a generated id too: the result hands
      // that id back, and retry_tool_call addresses the call by it.
      if (input.toolCallId || keptArgs) {
        await execute(registry, adapter, humanCtxWithBranch, "chat.cache_tool_result", {
          chatSessionId: input.chatSessionId,
          toolCallId,
          toolName: input.toolName,
          ok: result.ok,
          content: result.content,
          ...(keptArgs ? { args: keptArgs } : {}),
        });
      }

      // NB: no chat.append_message here. MCP-originated tool calls are
      // deliberately NOT written into the session transcript — the browser
      // chat replays persisted history through the SDK's response-messages
      // passthrough (CLAUDE.md §12), and orphan tool rows without their
      // assistant tool_use turn would corrupt that replay. The review
      // surface for MCP work is chat.list_pending_changes + snapshots,
      // which capture every write regardless.

      const approval = await tx.transaction((t) =>
        handOffQueuedProposal(t, {
          ok: result.ok,
          content: result.content,
          ...(result.queuedProposalId ? { queuedProposalId: result.queuedProposalId } : {}),
          chatSessionId: input.chatSessionId,
          requestedBy: auth.actorId,
          toolName: input.toolName,
          toolCallId,
        }),
      );

      return ok({
        ok: result.ok,
        content: result.content,
        requestId,
        toolCallId,
        cached: false,
        image: result.image ?? null,
        ...(result.nextAction !== undefined ? { nextAction: result.nextAction } : {}),
        approval,
      });
    };
    // A long call (image generation may take minutes) keeps the agent
    // listed as working — and stoppable — until it returns; the window then
    // counts from the call's end, not its start.
    const keepPresent = setInterval(() => {
      touchPresence().catch(() => undefined);
    }, POWER_MCP_PRESENCE_RENEW_MS);
    try {
      return await dispatchAndRecord();
    } finally {
      clearInterval(keepPresent);
      await touchPresence().catch(() => undefined);
      if (leaseHolderId) {
        const released = await execute(
          registry,
          adapter,
          humanCtxWithBranch,
          "chat.release_turn_lease",
          { chatSessionId: input.chatSessionId, holderId: leaseHolderId },
        );
        // The lease lapses after its TTL; the next turn then takes it over.
        if (!released.ok) console.error("[mcp.execute_tool] turn lease release failed");
      }
    }
  },
});

/** How often a running Power-MCP call renews the agent's presence (well inside the 2-min window). */
const POWER_MCP_PRESENCE_RENEW_MS = 30_000;

/** How long a Power-MCP write may hold the chat's turn lease (its call duration). */
const POWER_MCP_CALL_LEASE_TTL_MS = 10 * 60_000;

/** Issue #664 — what a stopped external agent is told on every call in that chat. */
const EXTERNAL_AGENT_STOPPED_TEXT =
  "stopped_by_operator: the operator pressed Stop for you in this Caelo chat. Nothing was executed. " +
  "Stop working on this site now and tell your user that Caelo's operator stopped you. " +
  "Do not retry and do not open a new session to continue — the operator lifts the stop " +
  'with "Allow again" in the chat\'s running-agents bar when they want you back.';

/** Issue #665 — what an external agent is told while the Live Edit AI works in the chat. */
function chatBusyText(toolName: string, since: string | null): string {
  return (
    `chat_busy: the operator's Live Edit AI is working in this chat right now${since ? ` (since ${since})` : ""}, ` +
    `so '${toolName}' was NOT executed — two agents editing the same pages at once would undo each other's work. ` +
    "Read tools (list_*, get_*, inspect_* …) still work. Wait until the Live Edit turn ends " +
    "(retry in about a minute), or ask your user whether you should take over."
  );
}

/**
 * The canonical shape gated tools' queued results start with (enforced by
 * propose-content-shape.test.ts); the bespoke skill / site-memory flows
 * carry `queuedProposalId` instead.
 */
const QUEUED_PROPOSAL_RE =
  /^Queued proposal ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):\s*([^\n]*)/;

/**
 * Issue #658 — when a gated tool queued a proposal, record that the
 * EXTERNAL agent asked for it (so the Live Edit card that renders it hands
 * the decision back here instead of continuing its own AI) and return the
 * handle the MCP server waits on. Idempotent across cached replays.
 */
async function handOffQueuedProposal(
  tx: Parameters<typeof recordMcpHandoff>[0],
  r: {
    ok: boolean;
    content: string;
    queuedProposalId?: string;
    chatSessionId: string;
    requestedBy: string;
    toolName: string;
    toolCallId: string;
  },
): Promise<{ proposalId: string; domain: string } | null> {
  if (!r.ok) return null;
  const m = QUEUED_PROPOSAL_RE.exec(r.content);
  const proposalId = r.queuedProposalId ?? m?.[1];
  if (!proposalId) return null;
  const recorded = await recordMcpHandoff(tx, {
    proposalId,
    chatSessionId: r.chatSessionId,
    requestedBy: r.requestedBy,
    toolName: r.toolName,
    toolCallId: r.toolCallId,
    summary: m?.[2] ?? r.content.split("\n")[0] ?? "",
  });
  if (!recorded) {
    // Every gated tool queues into a source pending_proposals.list knows;
    // a miss is drift between the two (CLAUDE.md §2 — say so loudly).
    console.error("[mcp.execute_tool] queued proposal in no known pending source", {
      proposalId,
      toolName: r.toolName,
    });
    return null;
  }
  return { proposalId, domain: recorded.domain };
}

// ─── mcp.get_approval_outcome ────────────────────────────────────────

export const mcpGetApprovalOutcomeOp = defineOperation({
  name: "mcp.get_approval_outcome",
  // Why system-only: the bearer token is in the input — the handler resolves the real actor from
  // it. Read-only for the agent: it learns the operator's decision, never makes it (§11.A).
  actorScope: ["system"],
  database: "cms_admin",
  // Issue #1210 — resolving the credential runs its own ops.
  transaction: "none",
  input: withCredential({ proposalId: z.string().uuid() }),
  output: z.object({
    proposalId: z.string(),
    domain: z.string(),
    toolName: z.string(),
    summary: z.string(),
    outcome: approvalOutcome,
    /** Operator's reject reason, or the applied tool's result summary. */
    detail: z.string().nullable(),
    decidedAt: z.string().nullable(),
  }),
  handler: async (_ctx, input, tx) => {
    const bridged = bridgeOrError();
    if (!bridged.ok) {
      return err({
        kind: "HandlerError",
        operation: "mcp.get_approval_outcome",
        message: bridged.message,
      });
    }
    const auth = await resolveAdminPrincipal(
      bridged.bridge.adapter,
      input,
      "mcp.get_approval_outcome",
    );
    if (!auth.ok) {
      return err({
        kind: "HandlerError",
        operation: "mcp.get_approval_outcome",
        message: auth.message,
      });
    }
    const view = await tx.transaction((t) =>
      readHandoffForAgent(t, input.proposalId, auth.actorId),
    );
    if (!view) {
      return err({
        kind: "HandlerError",
        operation: "mcp.get_approval_outcome",
        message:
          `approval_not_found: ${input.proposalId} is not a proposal you queued over MCP — ` +
          `pass the proposalId from the gated tool's result (list_pending_proposals shows what is waiting).`,
      });
    }
    return ok({
      proposalId: view.proposalId,
      domain: view.domain,
      toolName: view.toolName,
      summary: view.summary,
      outcome: view.outcome,
      detail: view.detail,
      decidedAt: view.decidedAt,
    });
  },
});

// ─── mcp.get_context ─────────────────────────────────────────────────

/**
 * #741 — how AI work is split on this connection, told to the agent once in
 * its context so a work item or an `AiDelegated:` answer is expected, not a
 * surprise. Depends on the token, so it is appended here rather than baked
 * into the static "power-mcp" prompt variant.
 */
export function aiWorkContract(allowCaeloAi: boolean): string {
  const workItems =
    "Some tools return a work item instead of doing AI work themselves: " +
    '`{ "workItem": { "kind": "ai_work_item", "task", "instructions": { "system", "user" }, "responseFormat", "apply": { "tool", "args", "resultArg" } } }` ' +
    "(or a list of them, e.g. translate_all_stale). Answer `instructions` with your own model exactly as asked (bare JSON when responseFormat is json), " +
    "then call `apply.tool` with `apply.args` plus your answer at `apply.resultArg` — a top-level argument name, or a path into apply.args such as `items[0].result`. " +
    "Batch work items of the same bulk tool into one call by concatenating their `items` arrays (apply_translations takes up to 100). " +
    "A work item without `apply` (a summary) is for you and your operator only.";
  return allowCaeloAi
    ? "## AI work on this connection\n\n" +
        "You do the reasoning; this token additionally lets you run AI work on the install's own AI (image generation, translation runs), " +
        "billed to the install and limited by the token's cost cap. Prefer doing text work yourself when you can — it costs the install nothing.\n\n" +
        workItems
    : "## AI work on this connection\n\n" +
        "All AI work happens in YOUR model, on your subscription — the install's AI is not available to this token. " +
        "Tools whose AI part you can do hand it back to you: translations (translate_variant / translate_all_stale / translate_chrome → apply_translations), " +
        "comment moderation, form summaries, newsletter drafts. add_module needs your parametrised HTML plus explicit `fields[]` (no server-side moduleize). " +
        "query_page_html in describe mode returns the HTML for you to extract from. generate_image / edit_image are unavailable: " +
        "create images yourself and upload them with caelo_upload_images. A tool answering `AiDelegated: …` names what to do instead.\n\n" +
        workItems;
}

const contextSkillRow = z.object({
  slug: z.string(),
  displayName: z.string(),
  description: z.string(),
  allowlistedTools: z.array(z.string()),
  /** Present only when includeSkillBodies=true (the export path). */
  body: z.string().optional(),
});

export const mcpGetContextOp = defineOperation({
  name: "mcp.get_context",
  // Why system-only: the bearer token is in the input — the handler resolves the real actor from
  // it.
  actorScope: ["system"],
  database: "cms_admin",
  // Issue #1210 — composes the context from a dozen reads, each its own op.
  transaction: "none",
  input: withCredential({
    /** True = include full skill bodies (the CLAUDE.md export path). */
    includeSkillBodies: z.boolean().optional(),
  }),
  output: z.object({
    /** The composed system context an external agent should load once. */
    systemContext: z.string(),
    /** Cold-start status line; null once the site foundation is complete. */
    statusLine: z.string().nullable(),
    skills: z.array(contextSkillRow),
  }),
  handler: async (_ctx, input, _tx) => {
    const bridged = bridgeOrError();
    if (!bridged.ok) {
      return err({ kind: "HandlerError", operation: "mcp.get_context", message: bridged.message });
    }
    const { adapter, registry } = bridged.bridge;
    const auth = await resolveAdminPrincipal(adapter, input, "mcp.get_context");
    if (!auth.ok) {
      return err({ kind: "HandlerError", operation: "mcp.get_context", message: auth.message });
    }
    const humanCtx: ExecutionContext = {
      actorId: auth.actorId,
      actorKind: "human",
      requestId: crypto.randomUUID(),
    };

    const memory = await loadMemory(registry, adapter, humanCtx);
    const skillsCtx = await buildSkillsContext(registry, adapter, humanCtx, {});
    // issue #413 — compose the "power-mcp" surface variant: the composer
    // itself drops the chat-runner-only chunks ("subagents",
    // "finishing-a-turn") and swaps the playbook's inspect/parallel entry
    // for the tools this surface actually serves. Dynamic parts (site
    // memory, skills index) can still name excluded tools, so the composed
    // string gets the same note as the catalogue descriptions.
    const chunks = composeSystemPromptChunks(
      memory,
      {
        ...(skillsCtx.skillsIndexBlock ? { skillsIndexBlock: skillsCtx.skillsIndexBlock } : {}),
      },
      "power-mcp",
    );
    const systemContext = withUnavailableToolsNote(
      [...chunks.map((c) => c.body), aiWorkContract(auth.allowCaeloAi)].join("\n\n"),
      POWER_MCP_EXCLUDED_TOOLS,
    );

    const [layoutsR, templatesR, defaultsR, themeR] = await Promise.all([
      execute(registry, adapter, humanCtx, "layouts.list", { includeDeleted: false }),
      execute(registry, adapter, humanCtx, "templates.list", { includeDeleted: false }),
      execute(registry, adapter, humanCtx, "site_defaults.get", {}),
      execute(registry, adapter, humanCtx, "themes.get_active", {}),
    ]);
    const statusLine = buildStatusLine({
      layoutsValue: layoutsR.ok ? layoutsR.value : null,
      templatesValue: templatesR.ok ? templatesR.value : null,
      siteDefaultsValue: defaultsR.ok ? defaultsR.value : null,
      activeTheme: themeR.ok
        ? (themeR.value as { theme: { origin?: string | null } | null }).theme
        : null,
    });

    const skillsList = await execute(registry, adapter, humanCtx, "skills.list", {
      status: "active",
    });
    const skillRows = skillsList.ok
      ? (
          skillsList.value as {
            skills: Array<{
              slug: string;
              displayName: string;
              description: string;
              body: string;
              allowlistedTools: string[];
            }>;
          }
        ).skills
      : [];

    // issue #413 — skill bodies are seeded/operator data written for the
    // chat surface (several MANDATE excluded tools: "call screenshot_page
    // for BOTH viewports"). They cannot be rewritten per surface, so every
    // excluded tool they mention is named in a note with the working alternative —
    // the content stays honest without touching the stored skill.
    const surfaced = (text: string) => withUnavailableToolsNote(text, POWER_MCP_EXCLUDED_TOOLS);
    return ok({
      systemContext,
      statusLine: statusLine ? surfaced(statusLine) : null,
      skills: skillRows.map((s) => ({
        slug: s.slug,
        displayName: s.displayName,
        description: surfaced(s.description),
        allowlistedTools: s.allowlistedTools,
        ...(input.includeSkillBodies ? { body: surfaced(s.body) } : {}),
      })),
    });
  },
});
