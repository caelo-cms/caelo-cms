// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #376 — Power-MCP ops: the admin-scoped MCP surface that exposes
 * the chat-runner tool catalogue to an EXTERNAL agent (Claude Code or any
 * MCP client). The external agent drives the tool loop itself; Caelo
 * executes one tool per `mcp.execute_tool` call with the same
 * ExecutionContext the chat-runner would use — so snapshots, audit,
 * branch scoping and chat-task grouping are byte-identical to a browser
 * chat. No Caelo-side provider call happens on this path; that is the
 * point (the reasoning cost moves to the caller's own agent).
 *
 * Invariants preserved (CLAUDE.md §11.A):
 * - Calls dispatch as an AI actor bound to the token's owner. An external
 *   model is an AI actor no matter who runs it, so human-only ops stay
 *   unreachable and gated `propose_*` tools fall back to their
 *   propose-only handler ("Queued proposal <uuid>: …") — the Owner
 *   approves in the per-domain pending queue, never the caller.
 * - Every call runs inside a chat session's preview branch. Publishing
 *   stays human/system-only; the operator publishes from the admin UI.
 */

import { pluginToolsRegistry, runPluginOperation } from "@caelo-cms/plugin-host";
import type { DatabaseAdapter } from "@caelo-cms/query-api";
import { defineOperation, execute } from "@caelo-cms/query-api";
import { type ExecutionContext, err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { buildSkillsContext } from "../../ai/chat-runner/context/skills.js";
import { buildStatusLine } from "../../ai/chat-runner/context-blocks.js";
import { loadMemory } from "../../ai/chat-runner/persistence.js";
import { composeSystemPromptChunks } from "../../ai/system-prompt.js";
import type { ToolRegistry, ToolResult } from "../../ai/tools/dispatch.js";
import { createDefaultToolRegistry } from "../../ai/tools/index.js";
import { annotateExcludedToolMentions } from "./mcp_power_prose.js";
import {
  getMcpBridge,
  type McpTokenScope,
  resolveMcpToken,
  type SendChatBridgeOpts,
} from "./mcp_tokens.js";

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
  [
    "screenshot_page",
    "needs the operator's browser via the SSE stream; use inspect_built_page / inspect_page_render, or screenshot the public URL yourself",
  ],
  ["offer_choices", "renders chat-UI choice chips; ask your own operator directly"],
  ["submit_result", "subagent-only structured result channel"],
]);

/**
 * Tools whose handlers make their OWN provider calls (image endpoints,
 * small-model extraction, translation). The per-token cost cap is
 * enforced before dispatching these — the chat-runner's streaming cap
 * does not run on this path.
 */
const AI_SPENDING_TOOLS: ReadonlySet<string> = new Set([
  "generate_image",
  "query_page_html",
  "translate_page",
  "start_translation_job",
]);

const toolCatalogueEntry = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  /** Present (true) for approval-gated propose_* tools — the call queues
   *  an Owner proposal instead of applying (the description says so too). */
  gated: z.boolean().optional(),
});

/**
 * The provider-shaped catalogue minus the excluded set, plus any live
 * Tier-1 plugin tools. Exported for the unit test.
 *
 * issue #413 — descriptions are annotated at this boundary rather than
 * reworded at their author sites: several descriptions (correctly, for
 * the chat surface) route to `screenshot_page` and friends, and the
 * in-app copies must stay untouched. Annotating here keeps every current
 * AND future description honest on this surface with one transform.
 */
export function powerToolCatalogue(tools: ToolRegistry): z.infer<typeof toolCatalogueEntry>[] {
  const core = tools
    .catalogue()
    .filter((t) => !POWER_MCP_EXCLUDED_TOOLS.has(t.name))
    .map((t) => ({
      name: t.name,
      description: annotateExcludedToolMentions(t.description, POWER_MCP_EXCLUDED_TOOLS),
      inputSchema: t.inputSchema,
      ...(t.gated ? { gated: true } : {}),
    }));
  const plugin = pluginToolsRegistry.list().map((p) => ({
    name: p.spec.name,
    description: annotateExcludedToolMentions(p.spec.description, POWER_MCP_EXCLUDED_TOOLS),
    inputSchema: p.spec.inputJsonSchema,
  }));
  return [...core, ...plugin];
}

/**
 * Bearer → actor for the Power-MCP surface. Same resolution as
 * mcp.send_chat plus the scope check; failures keep the `auth_error:`
 * prefix so the HTTP shell maps them to 401.
 */
async function resolveAdminScopedToken(
  adapter: DatabaseAdapter,
  plaintextToken: string,
  operation: string,
): Promise<
  | {
      ok: true;
      actorId: string;
      scope: McpTokenScope;
      aiCostCapMicrocents: number | null;
    }
  | { ok: false; message: string }
> {
  const resolved = await resolveMcpToken(adapter, plaintextToken);
  if (!resolved.ok) {
    return { ok: false, message: `auth_error: token ${resolved.error}` };
  }
  if (resolved.value.scope !== "admin") {
    return {
      ok: false,
      message:
        `auth_error: token scope '${resolved.value.scope}' — ${operation} needs an admin-scoped token. ` +
        `Mint one at /security/mcp (scope: admin); 'chat' tokens only drive caelo_chat.`,
    };
  }
  return {
    ok: true,
    actorId: resolved.value.actorId,
    scope: resolved.value.scope,
    aiCostCapMicrocents: resolved.value.aiCostCapMicrocents,
  };
}

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
  input: z.object({ plaintextToken: z.string().min(8).max(200) }).strict(),
  output: z.object({ tools: z.array(toolCatalogueEntry) }),
  handler: async (_ctx, input, _tx) => {
    const bridged = bridgeOrError();
    if (!bridged.ok) {
      return err({ kind: "HandlerError", operation: "mcp.list_tools", message: bridged.message });
    }
    const auth = await resolveAdminScopedToken(
      bridged.bridge.adapter,
      input.plaintextToken,
      "mcp.list_tools",
    );
    if (!auth.ok) {
      return err({ kind: "HandlerError", operation: "mcp.list_tools", message: auth.message });
    }
    return ok({ tools: powerToolCatalogue(createDefaultToolRegistry()) });
  },
});

// ─── mcp.open_session ────────────────────────────────────────────────

export const mcpOpenSessionOp = defineOperation({
  name: "mcp.open_session",
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      plaintextToken: z.string().min(8).max(200),
      /** Resume an existing session instead of creating one. */
      chatSessionId: z.string().uuid().optional(),
      title: z.string().min(1).max(200).optional(),
      /** Bind a NEW session to a page (subject to the one-open-chat-per-page gate). */
      pageId: z.string().uuid().optional(),
    })
    .strict(),
  output: z.object({
    chatSessionId: z.string(),
    chatBranchId: z.string(),
    resumed: z.boolean(),
  }),
  handler: async (_ctx, input, _tx) => {
    const bridged = bridgeOrError();
    if (!bridged.ok) {
      return err({ kind: "HandlerError", operation: "mcp.open_session", message: bridged.message });
    }
    const { adapter, registry } = bridged.bridge;
    const auth = await resolveAdminScopedToken(adapter, input.plaintextToken, "mcp.open_session");
    if (!auth.ok) {
      return err({ kind: "HandlerError", operation: "mcp.open_session", message: auth.message });
    }
    const humanCtx: ExecutionContext = {
      actorId: auth.actorId,
      actorKind: "human",
      requestId: crypto.randomUUID(),
    };
    if (input.chatSessionId) {
      const existing = await execute(registry, adapter, humanCtx, "chat.get_session", {
        chatSessionId: input.chatSessionId,
      });
      if (!existing.ok) {
        return err({
          kind: "HandlerError",
          operation: "mcp.open_session",
          message: `session_not_found: ${input.chatSessionId} — omit chatSessionId to open a fresh session`,
        });
      }
      const v = existing.value as { session: { chatBranchId: string } };
      return ok({
        chatSessionId: input.chatSessionId,
        chatBranchId: v.session.chatBranchId,
        resumed: true,
      });
    }
    const created = await execute(registry, adapter, humanCtx, "chat.create_session", {
      title: input.title ?? "MCP · admin session",
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
    return ok({ chatSessionId: c.chatSessionId, chatBranchId: c.chatBranchId, resumed: false });
  },
});

// ─── mcp.execute_tool ────────────────────────────────────────────────

export const mcpExecuteToolOp = defineOperation({
  name: "mcp.execute_tool",
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      plaintextToken: z.string().min(8).max(200),
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
    .strict(),
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
  }),
  handler: async (_ctx, input, tx) => {
    const bridged = bridgeOrError();
    if (!bridged.ok) {
      return err({ kind: "HandlerError", operation: "mcp.execute_tool", message: bridged.message });
    }
    const { adapter, registry, resolveProvider } = bridged.bridge;
    const auth = await resolveAdminScopedToken(adapter, input.plaintextToken, "mcp.execute_tool");
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
    const session = await execute(registry, adapter, humanCtx, "chat.get_session", {
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
        return ok({
          ok: cached.ok,
          content: cached.content,
          requestId,
          toolCallId,
          cached: true,
        });
      }
    }

    // Per-token cost cap, enforced at this boundary because the
    // chat-runner's streaming cap does not run on the Power-MCP path.
    // Scope: the work session's accumulated ai_calls spend — the closest
    // analogue to the chat-runner's per-turn accumulation.
    if (auth.aiCostCapMicrocents !== null && AI_SPENDING_TOOLS.has(input.toolName)) {
      const spendRows = (await tx.execute(sql`
        SELECT COALESCE(SUM(cost_estimate_microcents), 0)::bigint AS spent
        FROM ai_calls
        WHERE chat_session_id = ${input.chatSessionId}::uuid
      `)) as unknown as Array<{ spent: bigint | string | number }>;
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
            `cost cap reached: spent ~${spent} µ¢ / cap ${auth.aiCostCapMicrocents} µ¢ on this session — ` +
            `'${input.toolName}' makes its own AI provider calls and is blocked. Non-AI tools still work; ` +
            `the Owner can mint a higher-cap token at /security/mcp.`,
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
    const provider = await resolveProvider();
    const tools = createDefaultToolRegistry();

    // Tier-1 plugin tools route through the plugin host, exactly like the
    // chat-runner's dispatcher does (tool-dispatch.ts).
    const pluginTool = pluginToolsRegistry.resolve(input.toolName);
    const rawResult: ToolResult = pluginTool
      ? await runPluginOperation({
          pluginSlug: pluginTool.pluginSlug,
          operationName: pluginTool.spec.operationName,
          args: input.args ?? {},
        }).then(
          (r): ToolResult =>
            r.ok
              ? { ok: true, content: JSON.stringify(r.value) }
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
          // No spawnChildChatTurn / requestScreenshot / pushClientEvent:
          // the tools that need them are in POWER_MCP_EXCLUDED_TOOLS.
        });

    // issue #413 — tool-result prose is also authored for the chat surface
    // (e.g. inspect_page_render's summary hint says to call an excluded
    // screenshot tool next). Annotate at the same boundary as the catalogue
    // descriptions, BEFORE caching, so replays serve the same honest copy.
    const result: ToolResult = {
      ...rawResult,
      content: annotateExcludedToolMentions(rawResult.content, POWER_MCP_EXCLUDED_TOOLS),
    };

    if (input.toolCallId) {
      await execute(registry, adapter, humanCtxWithBranch, "chat.cache_tool_result", {
        chatSessionId: input.chatSessionId,
        toolCallId,
        toolName: input.toolName,
        ok: result.ok,
        content: result.content,
      });
    }

    // NB: no chat.append_message here. MCP-originated tool calls are
    // deliberately NOT written into the session transcript — the browser
    // chat replays persisted history through the SDK's response-messages
    // passthrough (CLAUDE.md §12), and orphan tool rows without their
    // assistant tool_use turn would corrupt that replay. The review
    // surface for MCP work is chat.list_pending_changes + snapshots,
    // which capture every write regardless.

    return ok({
      ok: result.ok,
      content: result.content,
      requestId,
      toolCallId,
      cached: false,
      image: result.image ?? null,
      ...(result.nextAction !== undefined ? { nextAction: result.nextAction } : {}),
    });
  },
});

// ─── mcp.get_context ─────────────────────────────────────────────────

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
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      plaintextToken: z.string().min(8).max(200),
      /** True = include full skill bodies (the CLAUDE.md export path). */
      includeSkillBodies: z.boolean().optional(),
    })
    .strict(),
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
    const auth = await resolveAdminScopedToken(adapter, input.plaintextToken, "mcp.get_context");
    if (!auth.ok) {
      return err({ kind: "HandlerError", operation: "mcp.get_context", message: auth.message });
    }
    const humanCtx: ExecutionContext = {
      actorId: auth.actorId,
      actorKind: "human",
      requestId: crypto.randomUUID(),
    };

    const memory = await loadMemory(registry, adapter, humanCtx);
    const skillsCtx = await buildSkillsContext(registry, adapter, humanCtx, {
      loadedSkillSlugs: [],
    });
    // issue #413 — compose the "power-mcp" surface variant: the composer
    // itself drops the chat-runner-only chunks ("subagents",
    // "finishing-a-turn") and swaps the playbook's inspect/parallel entry
    // for the tools this surface actually serves. Dynamic parts (site
    // memory, skills index) can still name excluded tools, so the composed
    // string gets the same annotation pass as the catalogue descriptions.
    const chunks = composeSystemPromptChunks(
      memory,
      {
        ...(skillsCtx.skillsIndexBlock ? { skillsIndexBlock: skillsCtx.skillsIndexBlock } : {}),
      },
      "power-mcp",
    );
    const systemContext = annotateExcludedToolMentions(
      chunks.map((c) => c.body).join("\n\n"),
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
    // excluded-tool mention is annotated with the working alternative —
    // the content stays honest without touching the stored skill.
    const surfaced = (text: string) => annotateExcludedToolMentions(text, POWER_MCP_EXCLUDED_TOOLS);
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
