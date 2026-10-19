// SPDX-License-Identifier: MPL-2.0

/**
 * P17 PR4 — MCP server token lifecycle ops + the dispatch endpoint the
 * MCP server bridges through.
 *
 * Auth model: an MCP token is a bearer secret hashed at rest. The
 * `mcp.send_chat` op (system-only) accepts a plaintext token, looks
 * up the (alive, unrevoked, non-expired) row, resolves the actor, and
 * dispatches `runChatTurn` against the existing chat-runner. Every
 * write the chat-runner emits attributes via the resolved actor —
 * RLS, audit, snapshots, ai_calls all flow exactly as if a human had
 * typed in the browser chat.
 */

import type { DatabaseAdapter } from "@caelo-cms/query-api";
import { defineOperation, execute, type OperationRegistry } from "@caelo-cms/query-api";
import {
  CAELO_VERSION,
  CHAT_MAX_ATTACHMENTS,
  chatAttachmentSchema,
  err,
  ok,
  type Result,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { readAgentStopEpoch, runChatTurn } from "../../ai/chat-runner.js";
import type { AIProvider } from "../../ai/provider.js";
import { createDefaultToolRegistry } from "../../ai/tools/index.js";
import { recordAudit, SYSTEM_ACTOR_ID } from "../../audit.js";
import { isOpenCard, type TurnApprovalStatus } from "../chat/turn-approval-state.js";

/**
 * Issue #376 — token scope. `chat` drives the caelo_chat surface only;
 * `admin` additionally unlocks the Power-MCP surface (mcp.list_tools /
 * mcp.execute_tool / mcp.open_session / mcp.get_context — see
 * ./mcp_power.ts).
 */
export const mcpTokenScope = z.enum(["chat", "admin"]);
export type McpTokenScope = z.infer<typeof mcpTokenScope>;

const tokenRow = z.object({
  id: z.string(),
  actorId: z.string(),
  displayName: z.string(),
  scope: mcpTokenScope,
  aiCostCapMicrocents: z.number().int().nonnegative().nullable(),
  /** #741 — an admin token may spend the install's own AI (off: the agent does the AI work). */
  allowCaeloAi: z.boolean(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
});

export const listMcpTokensOp = defineOperation({
  name: "mcp_tokens.list",
  // Why human-only: token registry is Owner-controlled — AI shouldn't
  // be able to enumerate active bearers.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({ tokens: z.array(tokenRow) }),
  handler: async (_ctx, _input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, actor_id::text AS actor_id, display_name, scope,
             ai_cost_cap_microcents, allow_caelo_ai, last_used_at, revoked_at,
             created_at, expires_at
      FROM mcp_tokens
      ORDER BY created_at DESC
    `)) as unknown as Array<{
      id: string;
      actor_id: string;
      display_name: string;
      scope: McpTokenScope;
      ai_cost_cap_microcents: bigint | string | number | null;
      allow_caelo_ai: boolean;
      last_used_at: string | Date | null;
      revoked_at: string | Date | null;
      created_at: string | Date;
      expires_at: string | Date;
    }>;
    const toN = (v: bigint | string | number | null): number | null =>
      v === null
        ? null
        : typeof v === "bigint"
          ? Number(v)
          : typeof v === "string"
            ? Number.parseInt(v, 10)
            : v;
    const toS = (v: string | Date | null): string | null =>
      v === null ? null : v instanceof Date ? v.toISOString() : String(v);
    return ok({
      tokens: rows.map((r) => ({
        id: r.id,
        actorId: r.actor_id,
        displayName: r.display_name,
        scope: r.scope,
        aiCostCapMicrocents: toN(r.ai_cost_cap_microcents),
        allowCaeloAi: r.allow_caelo_ai,
        lastUsedAt: toS(r.last_used_at),
        revokedAt: toS(r.revoked_at),
        createdAt: toS(r.created_at) ?? "",
        expiresAt: toS(r.expires_at) ?? "",
      })),
    });
  },
});

export const createMcpTokenOp = defineOperation({
  name: "mcp_tokens.create",
  // Why human-only: mints a bearer credential; the AI reaches it only through
  // propose_create_mcp_token (Owner-approved) and never sees a plaintext token.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      displayName: z.string().min(1).max(100),
      // Optional (not .default) so the execute_proposal path — which calls
      // this handler with the persisted payload, WITHOUT a Zod re-parse —
      // and a direct call behave identically via the `?? "chat"` below.
      scope: mcpTokenScope.optional(),
      aiCostCapMicrocents: z.number().int().nonnegative().nullable().optional(),
      /**
       * #741 — admin tokens only: the agent may use the install's own AI
       * (image generation, Caelo-side translation runs). Off by default.
       * Optional for the same execute_proposal reason as `scope`.
       */
      allowCaeloAi: z.boolean().optional(),
    })
    .strict(),
  output: z.object({
    id: z.string(),
    /** Plaintext bearer — returned ONCE; UI surfaces it as a save-now banner. */
    plaintextToken: z.string(),
  }),
  handler: async (ctx, input, tx) => {
    // 32 bytes random → hex with `mcp_` prefix for greppability in logs.
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const plaintextToken = `mcp_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(plaintextToken));
    const tokenHash = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const scope = input.scope ?? "chat";
    // The setting only exists on the Power-MCP surface; a chat token always
    // runs Caelo's own agent, so storing true there would mean nothing.
    if (input.allowCaeloAi === true && scope !== "admin") {
      return err({
        kind: "HandlerError",
        operation: "mcp_tokens.create",
        message:
          "allowCaeloAi applies to admin-scoped tokens only — a chat token always runs Caelo's own agent. Drop the flag or mint scope 'admin'.",
      });
    }
    const rows = (await tx.execute(sql`
      INSERT INTO mcp_tokens (actor_id, token_hash, display_name, scope, ai_cost_cap_microcents, allow_caelo_ai)
      VALUES (${ctx.actorId}::uuid, ${tokenHash}, ${input.displayName}, ${scope}, ${input.aiCostCapMicrocents ?? null}, ${input.allowCaeloAi === true})
      RETURNING id::text AS id
    `)) as unknown as Array<{ id: string }>;
    const id = rows[0]?.id;
    if (!id) {
      return err({
        kind: "HandlerError",
        operation: "mcp_tokens.create",
        message: "no id returned",
      });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId ?? SYSTEM_ACTOR_ID,
      requestId: ctx.requestId,
      operation: "mcp_tokens.create",
      input: { displayName: input.displayName, scope },
      succeeded: true,
      entityId: id,
      resultSummary: `display_name=${input.displayName} scope=${scope}`,
    });
    return ok({ id, plaintextToken });
  },
});

export const revokeMcpTokenOp = defineOperation({
  name: "mcp_tokens.revoke",
  // Why human-only: credential lifecycle; the AI reaches it only through propose_revoke_mcp_token
  // (Owner-approved).
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ id: z.string().uuid() }).strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    await tx.execute(sql`
      UPDATE mcp_tokens SET revoked_at = now()
      WHERE id = ${input.id}::uuid AND revoked_at IS NULL
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId ?? SYSTEM_ACTOR_ID,
      requestId: ctx.requestId,
      operation: "mcp_tokens.revoke",
      input,
      succeeded: true,
      entityId: input.id,
    });
    return ok({});
  },
});

/**
 * Token resolution helper. Trades a bearer for an actor + cap. Returns
 * a structured failure when the token is absent / expired / revoked.
 *
 * NOT an op: the bearer would otherwise appear in audit input. The
 * `mcp.send_chat` op above audits the resolved actor's chat write, not
 * this lookup.
 *
 * Exported for the Power-MCP ops (./mcp_power.ts) which share the same
 * bearer model but additionally require `scope === "admin"`.
 */
export async function resolveMcpToken(
  adapter: DatabaseAdapter,
  plaintextToken: string,
): Promise<
  Result<
    {
      actorId: string;
      tokenId: string;
      /** The Owner's label for the token — names the external agent in the UI. */
      displayName: string;
      scope: McpTokenScope;
      aiCostCapMicrocents: number | null;
      /** #741 — the token's agent may spend the install's AI (Power-MCP only). */
      allowCaeloAi: boolean;
    },
    "not_found" | "expired" | "revoked"
  >
> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(plaintextToken));
  const tokenHash = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return adapter.withAdminTransaction(
    {
      actorId: SYSTEM_ACTOR_ID,
      actorKind: "system",
      requestId: "mcp-resolve-token",
    },
    async (tx) => {
      const rows = (await tx.execute(sql`
        SELECT id::text AS id, actor_id::text AS actor_id, scope, display_name,
               ai_cost_cap_microcents, allow_caelo_ai, expires_at, revoked_at,
               (SELECT deleted_at FROM users u WHERE u.id = mcp_tokens.actor_id) AS user_deleted_at
        FROM mcp_tokens
        WHERE token_hash = ${tokenHash}
      `)) as unknown as Array<{
        id: string;
        actor_id: string;
        display_name: string;
        scope: McpTokenScope;
        ai_cost_cap_microcents: bigint | string | number | null;
        allow_caelo_ai: boolean;
        expires_at: string | Date;
        revoked_at: string | Date | null;
        user_deleted_at: string | Date | null;
      }>;
      const r = rows[0];
      if (!r) return err("not_found" as const);
      if (r.revoked_at || r.user_deleted_at) return err("revoked" as const);
      const expires = r.expires_at instanceof Date ? r.expires_at : new Date(String(r.expires_at));
      if (expires.getTime() < Date.now()) return err("expired" as const);
      await tx.execute(sql`
        UPDATE mcp_tokens SET last_used_at = now() WHERE id = ${r.id}::uuid
      `);
      const cap =
        r.ai_cost_cap_microcents === null
          ? null
          : typeof r.ai_cost_cap_microcents === "bigint"
            ? Number(r.ai_cost_cap_microcents)
            : typeof r.ai_cost_cap_microcents === "string"
              ? Number.parseInt(r.ai_cost_cap_microcents, 10)
              : r.ai_cost_cap_microcents;
      return ok({
        actorId: r.actor_id,
        tokenId: r.id,
        displayName: r.display_name,
        scope: r.scope,
        aiCostCapMicrocents: cap,
        allowCaeloAi: r.allow_caelo_ai === true,
      });
    },
  );
}

/**
 * Bridge wiring — admin bootstrap calls `configureMcpBridge` so the
 * `mcp.send_chat` op can dispatch into the chat-runner with the live
 * AIProvider. Same DI pattern translation/seo plugins use.
 */
export interface SendChatBridgeOpts {
  readonly adapter: DatabaseAdapter;
  readonly registry: OperationRegistry;
  /**
   * Resolves an AIProvider on each MCP turn. Returns null when no
   * provider is configured — the handler surfaces a structured error
   * pointing the operator at /settings/ai.
   */
  readonly resolveProvider: () => Promise<AIProvider | null>;
}
let bridgeOpts: SendChatBridgeOpts | null = null;
export function configureMcpBridge(opts: SendChatBridgeOpts): void {
  bridgeOpts = opts;
}
/** Read side of the DI singleton — shared with the Power-MCP ops. */
export function getMcpBridge(): SendChatBridgeOpts | null {
  return bridgeOpts;
}

const sendChatInput = z
  .object({
    plaintextToken: z.string().min(8).max(200),
    /** What the external agent says. Absent only on a resume (below). */
    message: z.string().min(1).max(50_000).optional(),
    /**
     * Issue #658 — resume this token's paused turn in `chatSessionId` once
     * the operator decided its approval cards (mcp.get_chat_approval_state
     * reads `decided`). The reply is the resumed turn's.
     */
    resumeApprovals: z.literal(true).optional(),
    attachments: z
      .array(
        chatAttachmentSchema.refine(
          (a) => a.assetId !== undefined,
          "MCP attachments must reference uploaded media assets",
        ),
      )
      .max(CHAT_MAX_ATTACHMENTS)
      .optional(),
    /** Continue an existing chat session; omit to start a fresh one. */
    chatSessionId: z.string().uuid().optional(),
    /** When starting fresh, bind the chat to this page so the page-context block populates. */
    pageId: z.string().uuid().optional(),
  })
  .strict()
  .refine((v) => (v.message !== undefined) !== (v.resumeApprovals === true), {
    message: "send either a message or resumeApprovals: true",
  })
  .refine((v) => v.resumeApprovals !== true || v.chatSessionId !== undefined, {
    message: "resumeApprovals needs the chatSessionId of the paused turn",
  });

/**
 * Issue #658 — an approval card the caelo_chat turn paused on. The operator
 * decides it in the Caelo admin (the Live Edit chat shows it as the external
 * agent's request); the agent waits for the decision and resumes.
 */
const pendingChatApproval = z.object({
  approvalId: z.string(),
  toolName: z.string(),
  preview: z.string(),
});

export const mcpSendChatOp = defineOperation({
  name: "mcp.send_chat",
  // Why system-only: bearer is in the input. We resolve it INSIDE the
  // handler then dispatch as the resolved actor; system privilege is
  // just to read mcp_tokens.
  actorScope: ["system"],
  database: "cms_admin",
  input: sendChatInput,
  output: z.object({
    chatSessionId: z.string(),
    requestId: z.string(),
    assistant: z.string(),
    toolCalls: z.array(z.object({ name: z.string(), summary: z.string(), succeeded: z.boolean() })),
    pendingProposals: z.number().int().nonnegative(),
    costMicrocents: z.number().int().nonnegative(),
    /**
     * Issue #658 — non-empty when the turn paused on approval cards: nothing
     * of them is applied until the operator decides; then resume with
     * `resumeApprovals: true` (the MCP server's caelo_await_approval).
     */
    pendingApprovals: z.array(pendingChatApproval),
  }),
  handler: async (_ctx, input, _tx) => {
    if (!bridgeOpts) {
      return err({
        kind: "HandlerError",
        operation: "mcp.send_chat",
        message: "MCP bridge not configured — admin bootstrap forgot to call configureMcpBridge",
      });
    }
    const { adapter, registry, resolveProvider } = bridgeOpts;
    const provider = await resolveProvider();
    if (!provider) {
      return err({
        kind: "HandlerError",
        operation: "mcp.send_chat",
        message:
          "AI provider not configured — visit /settings/ai to set up an API key, then retry.",
      });
    }
    const resolved = await resolveMcpToken(adapter, input.plaintextToken);
    if (!resolved.ok) {
      return err({
        kind: "HandlerError",
        operation: "mcp.send_chat",
        message: `auth_error: token ${resolved.error}`,
      });
    }
    const { actorId, aiCostCapMicrocents, tokenId } = resolved.value;

    // Fresh requestId per turn — MCP clients echo it back so the operator
    // can click through to /settings/audit/<id> for the full trail.
    const requestId = crypto.randomUUID();
    const humanCtx = {
      actorId,
      actorKind: "human" as const,
      requestId,
    };

    // Resolve / mint the chat session.
    let chatSessionId = input.chatSessionId;
    let chatBranchId: string | undefined;
    if (chatSessionId) {
      const existing = await execute(registry, adapter, humanCtx, "chat.get_session", {
        chatSessionId,
      });
      if (!existing.ok) {
        return err({
          kind: "HandlerError",
          operation: "mcp.send_chat",
          message: "session_not_found",
        });
      }
      const v = existing.value as { session: { chatBranchId: string } };
      chatBranchId = v.session.chatBranchId;
    } else {
      const created = await execute(registry, adapter, humanCtx, "chat.create_session", {
        title: `MCP · ${(input.message ?? "").slice(0, 50)}`,
        ...(input.pageId ? { pageId: input.pageId } : {}),
      });
      if (!created.ok) {
        return err({
          kind: "HandlerError",
          operation: "mcp.send_chat",
          message: "session_create_failed",
        });
      }
      const c = created.value as { chatSessionId: string; chatBranchId: string };
      chatSessionId = c.chatSessionId;
      chatBranchId = c.chatBranchId;
    }

    // Issue #664 — the chat's Stop count at arrival; a Stop before this turn
    // registers refuses it.
    const stopEpochAtArrival = await readAgentStopEpoch(registry, adapter, humanCtx, chatSessionId);
    const aiCtx = { actorId, actorKind: "ai" as const, requestId, chatBranchId };
    const turnHumanCtx = { ...humanCtx, chatBranchId };

    // Drive the chat-runner exactly like the SSE route does. Use a
    // fresh default tool registry — the MCP path inherits the full
    // catalogue (same surface a human would have).
    const tools = createDefaultToolRegistry();

    let assistantText = "";
    const toolStartByCallId = new Map<string, { name: string; arguments: unknown }>();
    const toolCalls: Array<{ name: string; summary: string; succeeded: boolean }> = [];
    let costUsd = 0;

    const stream = runChatTurn(
      {
        adapter,
        registry,
        provider,
        tools,
        aiCtx,
        humanCtx: turnHumanCtx,
        ...(aiCostCapMicrocents !== null ? { costCapMicrocents: aiCostCapMicrocents } : {}),
        // Issue #664 — listed in the chat's running agents; the operator's
        // Stop reaches it, and a stopped chat refuses it.
        agentRunSource: "mcp_chat",
        agentRunMcpTokenId: tokenId,
        ...(stopEpochAtArrival !== undefined ? { stopEpochAtArrival } : {}),
      },
      input.resumeApprovals === true
        ? { chatSessionId, resumeDecidedApprovals: true, chips: [], attachments: [] }
        : {
            chatSessionId,
            content: input.message,
            chips: [],
            attachments: input.attachments ?? [],
            ...(input.pageId ? { activePageId: input.pageId } : {}),
          },
    );
    const pendingApprovals: z.infer<typeof pendingChatApproval>[] = [];

    for await (const ev of stream) {
      if (ev.kind === "text-delta") {
        assistantText += ev.text;
      } else if (ev.kind === "tool-start") {
        toolStartByCallId.set(ev.toolCallId, { name: ev.name, arguments: ev.arguments });
      } else if (ev.kind === "tool-result") {
        const meta = toolStartByCallId.get(ev.toolCallId);
        const name = meta?.name ?? "<unknown>";
        // Truncate the result content to keep MCP responses lean — the
        // MCP client has the requestId for the full audit trail.
        const summary =
          ev.content.length > 400 ? `${ev.content.slice(0, 400)}… (truncated)` : ev.content;
        toolCalls.push({ name, summary, succeeded: ev.ok });
      } else if (ev.kind === "tool-approval-request") {
        pendingApprovals.push({
          approvalId: ev.approvalId,
          toolName: ev.name,
          preview: ev.preview,
        });
      } else if (ev.kind === "usage") {
        costUsd += ev.cost;
      } else if (ev.kind === "error") {
        return err({
          kind: "HandlerError",
          operation: "mcp.send_chat",
          message: `chat_error: ${ev.message}`,
        });
      } else if (
        ev.kind === "warning" &&
        (ev.code === "chat-stopped" || ev.code === "turn-dropped")
      ) {
        return err({
          kind: "HandlerError",
          operation: "mcp.send_chat",
          message: `stopped_by_operator: ${ev.message} Stop and tell your user; do not resend.`,
        });
      } else if (ev.kind === "interrupted") {
        return err({
          kind: "HandlerError",
          operation: "mcp.send_chat",
          message:
            "turn_interrupted: the turn ended before it finished — the operator pressed Stop in the Caelo chat, or another turn took the chat over. Tell your user; do not resend without asking.",
        });
      }
    }

    // Issue #658 — the cards this turn actually paused on are the ones the
    // runner recorded (an e2e auto-approved request yields the event too,
    // but continues instead of pausing).
    let awaiting: z.infer<typeof pendingChatApproval>[] = [];
    if (pendingApprovals.length > 0) {
      const open = await execute(
        registry,
        adapter,
        { ...humanCtx, requestId: `${requestId}-approvals` },
        "chat.list_turn_approvals",
        { chatSessionId },
      );
      if (!open.ok) {
        return err({
          kind: "HandlerError",
          operation: "mcp.send_chat",
          message: "chat_error: the turn paused on an approval, but its state could not be read",
        });
      }
      // Decided-but-not-resumed cards count too: the operator may have
      // clicked between the pause and this read, and the turn still needs
      // the agent's resume to apply the decision.
      const pendingIds = new Set(
        (
          open.value as { approvals: { approvalId: string; status: TurnApprovalStatus }[] }
        ).approvals
          .filter((a) => isOpenCard(a.status))
          .map((a) => a.approvalId),
      );
      awaiting = pendingApprovals.filter((a) => pendingIds.has(a.approvalId));
    }

    // Pending Owner-action proposals — single integer for the remote
    // agent to surface ("you have N things waiting").
    const pending = await execute(
      registry,
      adapter,
      { ...humanCtx, requestId: `${requestId}-pending-count` },
      "notifications.aggregate",
      {},
    );
    const pendingProposals = pending.ok
      ? ((pending.value as { pendingProposals?: number }).pendingProposals ?? 0)
      : 0;

    return ok({
      chatSessionId,
      requestId,
      assistant: assistantText,
      toolCalls,
      pendingProposals,
      costMicrocents: Math.round(costUsd * 1e8),
      pendingApprovals: awaiting,
    });
  },
});

/** Resolve the bearer and current write permission before accepting any image bytes. */
export const mcpAuthorizeUploadOp = defineOperation({
  name: "mcp.authorize_upload",
  // Why system-only: credentials are resolved here; bytes are stored as the human actor.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ plaintextToken: z.string().min(8).max(200) }).strict(),
  output: z.object({ actorId: z.string().uuid() }),
  handler: async (_ctx, input, tx) => {
    const bridge = getMcpBridge();
    if (!bridge)
      return err({
        kind: "HandlerError",
        operation: "mcp.authorize_upload",
        message: "MCP bridge not configured",
      });
    const resolved = await resolveMcpToken(bridge.adapter, input.plaintextToken);
    if (!resolved.ok)
      return err({
        kind: "HandlerError",
        operation: "mcp.authorize_upload",
        message: `auth_error: token ${resolved.error}`,
      });
    const actorId = resolved.value.actorId;
    const rows = (await tx.execute(sql`
      SELECT u.id FROM users u
      JOIN user_roles ur ON ur.user_id = u.id
      JOIN role_permissions rp ON rp.role_id = ur.role_id
      JOIN permissions p ON p.id = rp.permission_id
      WHERE u.id = ${actorId}::uuid AND u.deleted_at IS NULL AND p.name = 'content.write'
      LIMIT 1
    `)) as unknown as { id: string }[];
    if (!rows.length)
      return err({
        kind: "HandlerError",
        operation: "mcp.authorize_upload",
        message: "permission_denied: content.write required for an active user",
      });
    return ok({ actorId });
  },
});

/**
 * Issue #764 — the release the MCP shim must run. mcp-server ships in
 * lockstep with the admin, so the shim asks at startup and re-execs as
 * this exact version when it differs; the `claude mcp add` command then
 * never needs regenerating after an upgrade. Any token scope may ask
 * (chat and admin shims both handshake); the version is only disclosed
 * to a live token.
 */
export const mcpGetVersionOp = defineOperation({
  name: "mcp.get_version",
  // Why system-only: the bearer is in the input (same reason as
  // mcp.send_chat) — the HTTP shell dispatches as system.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ plaintextToken: z.string().min(8).max(200) }).strict(),
  output: z.object({ version: z.string() }),
  handler: async (_ctx, input, _tx) => {
    const bridge = getMcpBridge();
    if (!bridge)
      return err({
        kind: "HandlerError",
        operation: "mcp.get_version",
        message: "MCP bridge not configured",
      });
    const resolved = await resolveMcpToken(bridge.adapter, input.plaintextToken);
    if (!resolved.ok)
      return err({
        kind: "HandlerError",
        operation: "mcp.get_version",
        message: `auth_error: token ${resolved.error}`,
      });
    return ok({ version: CAELO_VERSION });
  },
});
