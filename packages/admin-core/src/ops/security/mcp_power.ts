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

import {
  pluginToolSurfaceGeneration,
  pluginToolsRegistry,
  runPluginOperation,
} from "@caelo-cms/plugin-host";
import type { DatabaseAdapter, OperationRegistry, QueryError } from "@caelo-cms/query-api";
import { defineOperation, execute } from "@caelo-cms/query-api";
import {
  type ExecutionContext,
  err,
  ok,
  type Result,
  untrustedToolResult,
} from "@caelo-cms/shared";
import { z } from "zod";
import { buildSkillsContext } from "../../ai/chat-runner/context/skills.js";
import { buildStatusLine } from "../../ai/chat-runner/context-blocks.js";
import { loadMemory } from "../../ai/chat-runner/persistence.js";
import { delegatedProvider } from "../../ai/delegated-provider.js";
import { chatPluginInvocation } from "../../ai/plugin-invocation.js";
import { queuePluginToolApproval } from "../../ai/queued-tool-approval.js";
import { composeSystemPromptChunks } from "../../ai/system-prompt.js";
import { keptCallArgs, RETRY_TOOL_NAME, withKeptCallNotice } from "../../ai/tools/_retry-keep.js";
import type { ToolRegistry, ToolResult } from "../../ai/tools/dispatch.js";
import { defaultToolRegistry } from "../../ai/tools/index.js";
import { installUnavailableToolNames } from "../../ai/tools/install-availability.js";
import { withToolCallVersion } from "../../tool-call-version.js";
import { mcpAgentOpFields } from "../chat/mcp-agent.js";
import { approvalOutcome, readHandoffForAgent } from "../mcp_approval_handoffs.js";
import { exactlyOneMcpCredential, mcpCredentialShape } from "./mcp_credential.js";
import { withUnavailableToolsNote } from "./mcp_power_prose.js";
import { type McpPrincipal, mcpAgentRefOf } from "./mcp_principal.js";
import { getMcpBridge, resolveMcpPrincipal, type SendChatBridgeOpts } from "./mcp_tokens.js";
import { bindTransportSession, type mcpBeginToolCallOp } from "./mcp_tool_call.js";

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

/**
 * The outcome of a Power-MCP step for a principal that is already resolved
 * (#1253): the value, or the message the op turns into a HandlerError.
 */
export type PowerResult<T> = { readonly ok: true; readonly value: T } | PowerFailure;
/** A refused Power-MCP step; `message` names the next step. */
export interface PowerFailure {
  readonly ok: false;
  readonly message: string;
}

const refused = (message: string): PowerFailure => ({ ok: false, message });

/**
 * Wrap a principal-taking Power-MCP step as an op body: resolve the
 * credential, run the step, map a refusal to a HandlerError. The remote
 * route calls the steps directly with the principal it resolved once for
 * the request (#1253); the stdio shim's REST calls come through the ops.
 */
async function asOp<T>(
  operation: string,
  credential: Parameters<typeof resolveMcpPrincipal>[1],
  step: (bridge: SendChatBridgeOpts, principal: McpPrincipal) => Promise<PowerResult<T>>,
): Promise<Result<T, QueryError>> {
  const bridged = bridgeOrError();
  if (!bridged.ok) return err({ kind: "HandlerError", operation, message: bridged.message });
  const auth = await resolveAdminPrincipal(bridged.bridge.adapter, credential, operation);
  if (!auth.ok) return err({ kind: "HandlerError", operation, message: auth.message });
  const r = await step(bridged.bridge, auth);
  return r.ok ? ok(r.value) : err({ kind: "HandlerError", operation, message: r.message });
}

/** The bridge, for a step the remote route runs in-process. */
export function powerBridge(): SendChatBridgeOpts {
  const bridged = bridgeOrError();
  if (!bridged.ok) throw new Error(bridged.message);
  return bridged.bridge;
}

// ─── catalogue (memoised, #1253) ─────────────────────────────────────

type CatalogueEntry = z.infer<typeof toolCatalogueEntry>;

let catalogueCache: {
  readonly key: string;
  readonly byDelegation: Map<boolean, readonly CatalogueEntry[]>;
} | null = null;

/**
 * The Power-MCP catalogue, built once per process and plugin tool surface
 * (`pluginToolSurfaceGeneration`) instead of once or twice per request:
 * 224 tools' descriptions and schemas, synchronous work that blocked the
 * event loop for every concurrent request. Exported for the unit test.
 */
export function cachedPowerToolCatalogue(aiDelegated: boolean): readonly CatalogueEntry[] {
  const unavailable = installUnavailableToolNames(process.env);
  const key = `${pluginToolSurfaceGeneration()}|${[...unavailable].sort().join(",")}`;
  if (catalogueCache?.key !== key) catalogueCache = { key, byDelegation: new Map() };
  let entries = catalogueCache.byDelegation.get(aiDelegated);
  if (entries === undefined) {
    entries = powerToolCatalogue(defaultToolRegistry(), { aiDelegated, unavailable });
    catalogueCache.byDelegation.set(aiDelegated, entries);
  }
  return entries;
}

/** The catalogue a principal sees (no database work). */
export function powerListTools(principal: McpPrincipal): readonly CatalogueEntry[] {
  return cachedPowerToolCatalogue(!principal.allowCaeloAi);
}

// ─── mcp.list_tools ──────────────────────────────────────────────────

export const mcpListToolsOp = defineOperation({
  name: "mcp.list_tools",
  readScope: "request",
  // Why system-only: the bearer is in the input (same reason as
  // mcp.send_chat) — the HTTP shell dispatches as system, the handler
  // resolves the real actor itself.
  actorScope: ["system"],
  database: "cms_admin",
  // Issue #1210 — resolving the credential runs its own ops.
  transaction: "none",
  input: withCredential({}),
  output: z.object({ tools: z.array(toolCatalogueEntry) }),
  handler: async (_ctx, input, _tx) =>
    asOp("mcp.list_tools", input, async (_bridge, principal) => ({
      ok: true,
      value: { tools: [...powerListTools(principal)] },
    })),
});

// ─── mcp.open_session ────────────────────────────────────────────────

/** Title of a session the Power-MCP opens without one. */
const MCP_SESSION_TITLE = "MCP · admin session";

/** The client a principal's chats are grouped under in the chat list (0453). */
function agentClientOf(principal: McpPrincipal): string {
  return principal.via.kind === "remote"
    ? principal.via.clientName.slice(0, 200)
    : principal.displayName.slice(0, 200);
}

const openSessionFields = {
  /** Resume this session (it must belong to the credential's user and be open). */
  chatSessionId: z.string().uuid().optional(),
  title: z.string().min(1).max(200).optional(),
  /** Bind the new session to this page. */
  pageId: z.string().uuid().optional(),
};

const openSessionOutput = z.object({
  chatSessionId: z.string(),
  chatBranchId: z.string(),
  title: z.string(),
  resumed: z.boolean(),
});

/** What {@link powerOpenSession} takes. */
export interface PowerOpenSessionInput {
  readonly chatSessionId?: string;
  readonly title?: string;
  readonly pageId?: string;
  /**
   * The remote transport session (`Mcp-Session-Id`) to bind the work
   * session to, so the agent's later calls without `workSessionId` use it.
   */
  readonly transportSessionId?: string;
}

/**
 * Issue #1253 — open the agent's work session. Without `chatSessionId`
 * every call opens a NEW session in the site's shared draft: one chat per
 * agent, so Undo, Stop and presence are each agent's own, and an agent
 * never lands in the operator's own chat unless it names that chat. With
 * `chatSessionId` it resumes that open session of the same user.
 */
export async function powerOpenSession(
  bridge: SendChatBridgeOpts,
  principal: McpPrincipal,
  input: PowerOpenSessionInput,
): Promise<PowerResult<z.infer<typeof openSessionOutput>>> {
  const { adapter, registry } = bridge;
  const humanCtx: ExecutionContext = {
    actorId: principal.actorId,
    actorKind: "human",
    requestId: crypto.randomUUID(),
  };
  let opened: z.infer<typeof openSessionOutput>;
  if (input.chatSessionId) {
    // chat.resolve_session filters by created_by: another user's session
    // reads as not found, so a credential can never resume someone else's.
    const existing = await execute(registry, adapter, humanCtx, "chat.resolve_session", {
      chatSessionId: input.chatSessionId,
    });
    if (!existing.ok) {
      return refused(
        `session_not_found: ${input.chatSessionId} — omit chatSessionId to open a new session of your own`,
      );
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
      return refused(
        `session_closed: ${input.chatSessionId} was already published, archived or discarded — omit chatSessionId to open a new session`,
      );
    }
    opened = {
      chatSessionId: input.chatSessionId,
      chatBranchId: v.session.chatBranchId,
      title: v.session.title,
      resumed: true,
    };
  } else {
    const title = input.title ?? MCP_SESSION_TITLE;
    const created = await execute(registry, adapter, humanCtx, "chat.create_session", {
      title,
      agentClient: agentClientOf(principal),
      ...(input.pageId ? { pageId: input.pageId } : {}),
    });
    if (!created.ok) {
      const detail = "message" in created.error ? created.error.message : created.error.kind;
      return refused(`session_create_failed: ${detail}`);
    }
    const c = created.value as { chatSessionId: string; chatBranchId: string };
    opened = {
      chatSessionId: c.chatSessionId,
      chatBranchId: c.chatBranchId,
      title,
      resumed: false,
    };
  }
  if (principal.via.kind === "remote" && input.transportSessionId !== undefined) {
    const connectionId = principal.via.connectionId;
    const transportSessionId = input.transportSessionId;
    await adapter.withAdminTransaction(
      humanCtx,
      (tx) => bindTransportSession(tx, connectionId, transportSessionId, opened.chatSessionId),
      { holder: "mcp.open_session.bind" },
    );
  }
  return { ok: true, value: opened };
}

export const mcpOpenSessionOp = defineOperation({
  name: "mcp.open_session",
  readScope: "request",
  // Why system-only: the bearer token is in the input (same reason as mcp.list_tools) — the HTTP
  // shell dispatches as system and the handler resolves the real actor.
  actorScope: ["system"],
  database: "cms_admin",
  // Issue #1210 — an orchestration of chat ops: holding a transaction around
  // them would make every one a second checkout of the pool.
  transaction: "none",
  input: withCredential(openSessionFields),
  output: openSessionOutput,
  handler: async (_ctx, input, _tx) =>
    asOp("mcp.open_session", input, (bridge, principal) =>
      powerOpenSession(bridge, principal, {
        ...(input.chatSessionId ? { chatSessionId: input.chatSessionId } : {}),
        ...(input.title ? { title: input.title } : {}),
        ...(input.pageId ? { pageId: input.pageId } : {}),
      }),
    ),
});

// ─── mcp.execute_tool ────────────────────────────────────────────────

const executeOutput = z.object({
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
});
type ExecuteOutput = z.infer<typeof executeOutput>;

/** What {@link powerExecuteTool} takes. */
export interface PowerExecuteInput {
  readonly toolName: string;
  readonly args?: Record<string, unknown>;
  /**
   * Caller-supplied idempotency key. Re-sending the same (session,
   * toolCallId) returns the cached first result instead of re-executing.
   */
  readonly toolCallId?: string;
  /** The work session; else the one bound to `transportSessionId`. */
  readonly chatSessionId?: string;
  /** Remote only: the transport session whose bound work session to use. */
  readonly transportSessionId?: string;
}

/** Why a call found no session to run in — the agent's next step. */
const NO_WORK_SESSION =
  "no_work_session: no work session for this call — call caelo_open_session first and run your calls in the session it returns; when several agents share this connection, pass its id as workSessionId on every call. Every caelo write lands in a session's chat.";

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

/**
 * Issue #376 / #1253 — run one catalogue tool for an external agent, with
 * the same ExecutionContext the chat-runner would use (snapshots, audit,
 * branch scoping, chat-task grouping). Outside the tool's own ops it costs
 * two transactions (`mcp.begin_tool_call`, `mcp.finish_tool_call`); no
 * per-chat write slot is taken — writes conflict per entity, against the
 * snapshot the call started with (tool-call-version.ts).
 */
export async function powerExecuteTool(
  bridge: SendChatBridgeOpts,
  principal: McpPrincipal,
  input: PowerExecuteInput,
): Promise<PowerResult<ExecuteOutput>> {
  const excludedReason = POWER_MCP_EXCLUDED_TOOLS.get(input.toolName);
  if (excludedReason) {
    return refused(`tool '${input.toolName}' is not available over MCP: ${excludedReason}`);
  }
  const { adapter, registry, resolveProvider } = bridge;
  const tools = defaultToolRegistry();
  const requestId = crypto.randomUUID();
  const humanCtx: ExecutionContext = {
    actorId: principal.actorId,
    actorKind: "human",
    requestId,
  };
  // #741 — without the Owner's opt-in the call is AI-delegated and cannot
  // spend the install's AI at all, so there is nothing to cap. Which tools
  // the cap gates comes from each tool's own `usesInstallAi` declaration.
  const aiDelegated = !principal.allowCaeloAi;
  // #1275 — a retry runs the KEPT call's tool, so the cap follows that
  // tool, not retry_tool_call (no new path around the cap). Without the
  // session id up front the kept call cannot be looked up yet, so such a
  // retry counts as capped: a cap that is reached refuses it rather than
  // letting an AI-spending call through.
  const mayCap = !aiDelegated && principal.aiCostCapMicrocents !== null;
  const capToolName =
    mayCap && input.toolName === RETRY_TOOL_NAME && input.chatSessionId
      ? await keptToolNameOf(registry, adapter, humanCtx, input.chatSessionId, input.args)
      : input.toolName;
  const capped =
    mayCap &&
    (capToolName === RETRY_TOOL_NAME
      ? input.chatSessionId === undefined
      : toolUsesInstallAi(tools, capToolName));
  const agent = mcpAgentOpFields(mcpAgentRefOf(principal));
  const label =
    `External agent "${principal.displayName}" (${principal.via.kind === "remote" ? "remote MCP" : "MCP"})`.slice(
      0,
      200,
    );
  let session:
    | { chatSessionId: string }
    | { remoteConnectionId: string; transportSessionId: string };
  if (input.chatSessionId) {
    session = { chatSessionId: input.chatSessionId };
  } else if (principal.via.kind === "remote" && input.transportSessionId !== undefined) {
    session = {
      remoteConnectionId: principal.via.connectionId,
      transportSessionId: input.transportSessionId,
    };
  } else {
    return refused(NO_WORK_SESSION);
  }
  const begun = await execute(registry, adapter, humanCtx, "mcp.begin_tool_call", {
    session,
    agent,
    label,
    toolName: input.toolName,
    ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
    ...(capped ? { costCapMicrocents: principal.aiCostCapMicrocents as number } : {}),
  });
  if (!begun.ok) {
    const detail = "message" in begun.error ? begun.error.message : begun.error.kind;
    return refused(`call_setup_failed: ${detail} — nothing was executed; retry the call`);
  }
  const start = begun.value as z.infer<(typeof mcpBeginToolCallOp)["output"]>;
  const toolCallId = input.toolCallId ?? `mcp-${requestId}`;
  switch (start.status) {
    case "no_session":
      return refused(NO_WORK_SESSION);
    case "not_found":
      return refused(
        "session_not_found — open a work session first (the caelo_open_session tool) and run your calls in it; every Power-MCP write lands on that session's branch.",
      );
    case "closed":
      return refused(
        `session_closed: ${start.chatSessionId} was published, archived or discarded — call caelo_open_session for a new session`,
      );
    case "stopped":
      return {
        ok: true,
        value: {
          ok: false,
          content: EXTERNAL_AGENT_STOPPED_TEXT,
          requestId,
          toolCallId,
          cached: false,
          image: null,
        },
      };
    case "cached":
      return {
        ok: true,
        value: {
          ok: start.cached.ok,
          content: start.cached.content,
          requestId,
          toolCallId,
          cached: true,
          approval: start.approval,
        },
      };
    case "in_progress":
      return refused(
        `in_progress: the same call (toolCallId ${toolCallId}) is still running, so it was not started again. Wait for it, then repeat the call to get its result.`,
      );
    case "cost_capped":
      return refused(
        `cost cap reached: spent ~${start.spent} µ¢ / cap ${principal.aiCostCapMicrocents} µ¢ of the install's AI on this session — ` +
          `'${input.toolName}' uses the install's AI and was not run. Tools without AI work still run. Ask the Owner for a higher-cap token at /settings/mcp, ` +
          `or for a token without "may use Caelo's AI", which hands the AI work back to you instead of spending the install's AI.`,
      );
    case "ready":
      break;
  }
  const { chatSessionId, chatBranchId, snapshot } = start;
  const humanCtxWithBranch: ExecutionContext = { ...humanCtx, chatBranchId };
  // chatTaskId = chatSessionId is the chat-runner's own convention — it
  // groups this call's snapshots under the session for chat-keyed undo.
  const aiCtx: ExecutionContext = {
    actorId: principal.actorId,
    actorKind: "ai",
    requestId,
    chatBranchId,
    chatTaskId: chatSessionId,
  };

  const dispatch = async (): Promise<ToolResult> => {
    const resolvedProvider = await resolveProvider();
    const provider =
      resolvedProvider && aiDelegated ? delegatedProvider(resolvedProvider) : resolvedProvider;
    // Tier-1 plugin tools route through the plugin host, exactly like the
    // chat-runner's dispatcher does (tool-dispatch.ts).
    //
    // #687 — an approval-declared plugin tool (set_locales, …) cannot pause
    // an SDK turn here (the external agent drives its own loop), so it is
    // queued for the operator instead: the card shows in their Live Edit
    // chat and the pending queue, Approve runs it through the plugin host,
    // and the decision is handed back like any other gated call. Running it
    // unqueued would reopen the bypass #388 closed.
    const pluginTool = pluginToolsRegistry.resolve(input.toolName);
    if (pluginTool?.spec.approvalMode) {
      return queuePluginToolApproval({
        registry,
        adapter,
        aiCtx,
        operatorActorId: principal.actorId,
        chatSessionId,
        pluginTool,
        args: input.args ?? {},
        aiDelegated,
      });
    }
    if (pluginTool) {
      const r = await runPluginOperation({
        pluginSlug: pluginTool.pluginSlug,
        operationName: pluginTool.spec.operationName,
        args: input.args ?? {},
        invocation: chatPluginInvocation(aiCtx, principal.actorId, { aiDelegated }),
      });
      return r.ok
        ? // #635 — plugin data may be visitor-written: data, never instructions.
          { ok: true, content: untrustedToolResult(r.value) }
        : { ok: false, content: `${r.error.kind}: ${r.error.message}` };
    }
    return tools.dispatch(input.toolName, input.args ?? {}, aiCtx, {
      adapter,
      registry,
      chatSessionId,
      chatBranchId,
      toolCallId,
      tools,
      humanCtx: humanCtxWithBranch,
      ...(provider ? { provider } : {}),
      ...(aiDelegated ? { aiDelegated: true } : {}),
      // No spawnChildChatTurn / requestScreenshot / pushClientEvent: the
      // tools that need them are in POWER_MCP_EXCLUDED_TOOLS. screenshot_page
      // works WITHOUT them since issue #412 — with no pushClientEvent it
      // renders the branch preview server-side and returns the image, which
      // flows to the MCP client as an image content block.
    });
  };

  // A long call (image generation may take minutes) keeps the agent listed
  // as working — and stoppable — until it returns.
  const keepPresent = setInterval(() => {
    execute(registry, adapter, humanCtxWithBranch, "chat.touch_external_agent", {
      chatSessionId,
      ...agent,
      label,
    }).catch(() => undefined);
  }, POWER_MCP_PRESENCE_RENEW_MS);
  let raw: ToolResult;
  try {
    raw = await withToolCallVersion({ callId: requestId, snapshot }, dispatch);
  } catch (e) {
    // Recorded like any failed result, so the reserved key holds the
    // outcome and a repeat does not run the tool again.
    raw = {
      ok: false,
      content: `tool_failed: '${input.toolName}' threw: ${e instanceof Error ? e.message : String(e)}`,
    };
  } finally {
    clearInterval(keepPresent);
  }

  // issue #413 — results that ARE instruction prose (load_skill's skill
  // bodies) get the same excluded-tool note as the catalogue, BEFORE
  // caching so replays serve the same honest copy. Every other result is
  // site data and must round-trip unchanged (bug 2c323d9a).
  //
  // #1275 — a fixable failed write call is kept for retry_tool_call, exactly
  // like in the browser chat (plugin results never carry `call`). A kept
  // call is recorded under the generated id too: the result hands that id
  // back, and retry_tool_call addresses the call by it.
  const keptArgs = keptCallArgs(raw, tools);
  const kept = keptArgs ? withKeptCallNotice(toolCallId, raw) : raw;
  const content = surfaceToolResultContent(input.toolName, kept.content);
  const finished = await execute(registry, adapter, humanCtxWithBranch, "mcp.finish_tool_call", {
    chatSessionId,
    agent,
    label,
    toolName: input.toolName,
    toolCallId,
    cache: input.toolCallId !== undefined || keptArgs !== null,
    ...(keptArgs ? { args: keptArgs } : {}),
    result: {
      ok: raw.ok,
      content,
      ...(raw.queuedProposalId ? { queuedProposalId: raw.queuedProposalId } : {}),
    },
  });
  if (!finished.ok) {
    const detail = "message" in finished.error ? finished.error.message : finished.error.kind;
    // The tool ran; only its bookkeeping failed. Say so instead of
    // inviting a retry that would run it twice.
    return refused(
      `call_record_failed: '${input.toolName}' ran (ok=${raw.ok}), but recording its result failed: ${detail}. Do not repeat the call; read the state you changed to see its effect.`,
    );
  }
  const after = finished.value as { notes: string[]; approval: ExecuteOutput["approval"] };
  // NB: no chat.append_message here. MCP-originated tool calls are
  // deliberately NOT written into the session transcript — the browser chat
  // replays persisted history through the SDK's response-messages
  // passthrough (CLAUDE.md §12), and orphan tool rows without their
  // assistant tool_use turn would corrupt that replay. The review surface
  // for MCP work is chat.list_pending_changes + snapshots.
  //
  // Issue #620 — a write that took over another chat's lock (or lost one)
  // says so in this result, same as in the browser chat.
  return {
    ok: true,
    value: {
      ok: raw.ok,
      content:
        after.notes.length === 0
          ? content
          : `${content}\n\n${after.notes.map((n) => `Note: ${n}`).join("\n")}`,
      requestId,
      toolCallId,
      cached: false,
      image: raw.image ?? null,
      ...(raw.nextAction !== undefined ? { nextAction: raw.nextAction } : {}),
      approval: after.approval,
    },
  };
}

export const mcpExecuteToolOp = defineOperation({
  name: "mcp.execute_tool",
  readScope: "request",
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
      /** The work session whose branch this call writes to. */
      chatSessionId: z.string().uuid(),
      toolName: z.string().min(1).max(120),
      args: z.record(z.string(), z.unknown()).optional(),
      /** Caller-supplied idempotency key (see {@link PowerExecuteInput}). */
      toolCallId: z.string().min(1).max(128).optional(),
    })
    .strict()
    .refine(exactlyOneMcpCredential.check, { message: exactlyOneMcpCredential.message }),
  output: executeOutput,
  handler: async (_ctx, input, _tx) =>
    asOp("mcp.execute_tool", input, (bridge, principal) =>
      powerExecuteTool(bridge, principal, {
        toolName: input.toolName,
        chatSessionId: input.chatSessionId,
        ...(input.args ? { args: input.args } : {}),
        ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      }),
    ),
});

/** How often a running Power-MCP call renews the agent's presence (well inside the 2-min window). */
const POWER_MCP_PRESENCE_RENEW_MS = 30_000;

/** Issue #664 — what a stopped external agent is told on every call in that chat. */
const EXTERNAL_AGENT_STOPPED_TEXT =
  "stopped_by_operator: the operator pressed Stop for you in this Caelo chat. Nothing was executed. " +
  "Stop working on this site now and tell your user that Caelo's operator stopped you. " +
  "Do not retry and do not open a new session to continue — the operator lifts the stop " +
  'with "Allow again" in the chat\'s running-agents bar when they want you back.';

// ─── mcp.get_approval_outcome ────────────────────────────────────────

const approvalOutcomeOutput = z.object({
  proposalId: z.string(),
  domain: z.string(),
  toolName: z.string(),
  summary: z.string(),
  outcome: approvalOutcome,
  /** Operator's reject reason, or the applied tool's result summary. */
  detail: z.string().nullable(),
  decidedAt: z.string().nullable(),
});

/**
 * Issue #658 — the operator's decision on a proposal this agent queued.
 * Read-only for the agent: it learns the decision, never makes it (§11.A).
 * The approval wait polls this with the principal its request resolved
 * once (#1253), not by re-resolving the credential every poll.
 */
export async function powerApprovalOutcome(
  bridge: SendChatBridgeOpts,
  principal: McpPrincipal,
  proposalId: string,
): Promise<PowerResult<z.infer<typeof approvalOutcomeOutput>>> {
  const view = await bridge.adapter.withAdminTransaction(
    { actorId: principal.actorId, actorKind: "human", requestId: crypto.randomUUID() },
    (t) => readHandoffForAgent(t, proposalId, principal.actorId),
    { holder: "mcp.get_approval_outcome" },
  );
  if (!view) {
    return refused(
      `approval_not_found: ${proposalId} is not a proposal you queued over MCP — ` +
        `pass the proposalId from the gated tool's result (list_pending_proposals shows what is waiting).`,
    );
  }
  return {
    ok: true,
    value: {
      proposalId: view.proposalId,
      domain: view.domain,
      toolName: view.toolName,
      summary: view.summary,
      outcome: view.outcome,
      detail: view.detail,
      decidedAt: view.decidedAt,
    },
  };
}

export const mcpGetApprovalOutcomeOp = defineOperation({
  name: "mcp.get_approval_outcome",
  readScope: "request",
  // Why system-only: the bearer token is in the input — the handler resolves the real actor from
  // it. Read-only for the agent: it learns the operator's decision, never makes it (§11.A).
  actorScope: ["system"],
  database: "cms_admin",
  // Issue #1210 — resolving the credential runs its own ops.
  transaction: "none",
  input: withCredential({ proposalId: z.string().uuid() }),
  output: approvalOutcomeOutput,
  handler: async (_ctx, input, _tx) =>
    asOp("mcp.get_approval_outcome", input, (bridge, principal) =>
      powerApprovalOutcome(bridge, principal, input.proposalId),
    ),
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

const contextOutput = z.object({
  /** The composed system context an external agent should load once. */
  systemContext: z.string(),
  /** Cold-start status line; null once the site foundation is complete. */
  statusLine: z.string().nullable(),
  skills: z.array(contextSkillRow),
});

export const mcpGetContextOp = defineOperation({
  name: "mcp.get_context",
  readScope: "request",
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
  output: contextOutput,
  handler: async (_ctx, input, _tx) =>
    asOp("mcp.get_context", input, async (bridge, principal) => ({
      ok: true,
      value: await powerGetContext(bridge, principal, input.includeSkillBodies === true),
    })),
});

/**
 * The composed context an external agent loads once (system prompt
 * chunks, status line, skills), for a resolved principal.
 */
export async function powerGetContext(
  bridge: SendChatBridgeOpts,
  principal: McpPrincipal,
  includeSkillBodies: boolean,
): Promise<z.infer<typeof contextOutput>> {
  const { adapter, registry } = bridge;
  const humanCtx: ExecutionContext = {
    actorId: principal.actorId,
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
    [...chunks.map((c) => c.body), aiWorkContract(principal.allowCaeloAi)].join("\n\n"),
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
  return {
    systemContext,
    statusLine: statusLine ? surfaced(statusLine) : null,
    skills: skillRows.map((s) => ({
      slug: s.slug,
      displayName: s.displayName,
      description: surfaced(s.description),
      allowlistedTools: s.allowlistedTools,
      ...(includeSkillBodies ? { body: surfaced(s.body) } : {}),
    })),
  };
}
