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

import { defineOperation, execute, type OperationRegistry } from "@caelo/query-api";
import type { DatabaseAdapter } from "@caelo/query-api";
import { err, ok, type Result } from "@caelo/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { AIProvider } from "../../ai/provider.js";
import { runChatTurn } from "../../ai/chat-runner.js";
import { createDefaultToolRegistry } from "../../ai/tools/index.js";
import { recordAudit, SYSTEM_ACTOR_ID } from "../../audit.js";

const tokenRow = z.object({
  id: z.string(),
  actorId: z.string(),
  displayName: z.string(),
  aiCostCapMicrocents: z.number().int().nonnegative().nullable(),
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
      SELECT id::text AS id, actor_id::text AS actor_id, display_name,
             ai_cost_cap_microcents, last_used_at, revoked_at,
             created_at, expires_at
      FROM mcp_tokens
      ORDER BY created_at DESC
    `)) as unknown as Array<{
      id: string;
      actor_id: string;
      display_name: string;
      ai_cost_cap_microcents: bigint | string | number | null;
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
        aiCostCapMicrocents: toN(r.ai_cost_cap_microcents),
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
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      displayName: z.string().min(1).max(100),
      aiCostCapMicrocents: z.number().int().nonnegative().nullable().optional(),
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

    const rows = (await tx.execute(sql`
      INSERT INTO mcp_tokens (actor_id, token_hash, display_name, ai_cost_cap_microcents)
      VALUES (${ctx.actorId}::uuid, ${tokenHash}, ${input.displayName}, ${input.aiCostCapMicrocents ?? null})
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
      input: { displayName: input.displayName },
      succeeded: true,
      entityId: id,
      resultSummary: `display_name=${input.displayName}`,
    });
    return ok({ id, plaintextToken });
  },
});

export const revokeMcpTokenOp = defineOperation({
  name: "mcp_tokens.revoke",
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
 */
async function resolveMcpToken(
  adapter: DatabaseAdapter,
  plaintextToken: string,
): Promise<
  Result<
    { actorId: string; tokenId: string; aiCostCapMicrocents: number | null },
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
        SELECT id::text AS id, actor_id::text AS actor_id,
               ai_cost_cap_microcents, expires_at, revoked_at
        FROM mcp_tokens
        WHERE token_hash = ${tokenHash}
      `)) as unknown as Array<{
        id: string;
        actor_id: string;
        ai_cost_cap_microcents: bigint | string | number | null;
        expires_at: string | Date;
        revoked_at: string | Date | null;
      }>;
      const r = rows[0];
      if (!r) return err("not_found" as const);
      if (r.revoked_at) return err("revoked" as const);
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
      return ok({ actorId: r.actor_id, tokenId: r.id, aiCostCapMicrocents: cap });
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
  readonly provider: AIProvider;
}
let bridgeOpts: SendChatBridgeOpts | null = null;
export function configureMcpBridge(opts: SendChatBridgeOpts): void {
  bridgeOpts = opts;
}

const sendChatInput = z
  .object({
    plaintextToken: z.string().min(8).max(200),
    message: z.string().min(1).max(50_000),
    /** Continue an existing chat session; omit to start a fresh one. */
    chatSessionId: z.string().uuid().optional(),
    /** When starting fresh, bind the chat to this page so the page-context block populates. */
    pageId: z.string().uuid().optional(),
  })
  .strict();

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
    toolCalls: z.array(
      z.object({ name: z.string(), summary: z.string(), succeeded: z.boolean() }),
    ),
    pendingProposals: z.number().int().nonnegative(),
    costMicrocents: z.number().int().nonnegative(),
  }),
  handler: async (_ctx, input, _tx) => {
    if (!bridgeOpts) {
      return err({
        kind: "HandlerError",
        operation: "mcp.send_chat",
        message: "MCP bridge not configured — admin bootstrap forgot to call configureMcpBridge",
      });
    }
    const { adapter, registry, provider } = bridgeOpts;
    const resolved = await resolveMcpToken(adapter, input.plaintextToken);
    if (!resolved.ok) {
      return err({
        kind: "HandlerError",
        operation: "mcp.send_chat",
        message: `auth_error: token ${resolved.error}`,
      });
    }
    const { actorId, aiCostCapMicrocents } = resolved.value;

    // Fresh requestId per turn — MCP clients echo it back so the operator
    // can click through to /security/audit/<id> for the full trail.
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
        title: `MCP · ${input.message.slice(0, 50)}`,
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
      },
      {
        chatSessionId,
        content: input.message,
        chips: [],
        ...(input.pageId ? { activePageId: input.pageId } : {}),
      },
    );

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
      } else if (ev.kind === "usage") {
        costUsd += ev.cost;
      } else if (ev.kind === "error") {
        return err({
          kind: "HandlerError",
          operation: "mcp.send_chat",
          message: `chat_error: ${ev.message}`,
        });
      }
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
    });
  },
});
